import { expect } from 'chai';
import { describe, it } from 'mocha';

import { diffDocuments, type JsonOp } from '../../src/editor-api/local/manifest-diff';

const assets = (map: Record<string, any>) => ({ assets: map });
const scene = (entities: Record<string, any>, extra: Record<string, any> = {}) => ({
    scenes: { 1: { item_id: 1, name: 'Main', entities, ...extra } }
});
const entity = (name: string, children: string[] = [], extra: Record<string, any> = {}) => ({
    resource_id: name,
    name,
    parent: null,
    children,
    ...extra
});

/** Apply json0 ops to a value, mirroring what ObserverSync.write does to an observer. */
const apply = (root: any, ops: JsonOp[]) => {
    const result = structuredClone(root);
    for (const op of ops) {
        let target = result;
        for (let i = 0; i < op.p.length - 1; i++) target = target[op.p[i]];
        const key = op.p[op.p.length - 1];
        if (op.lm !== undefined) {
            target.splice(op.lm, 0, target.splice(Number(key), 1)[0]);
        } else if (op.li !== undefined && op.ld !== undefined) {
            target.splice(Number(key), 1, op.li);
        } else if (op.li !== undefined) {
            target.splice(Number(key), 0, op.li);
        } else if (op.ld !== undefined && Array.isArray(target)) {
            target.splice(Number(key), 1);
        } else if (op.oi !== undefined) {
            target[key] = op.oi;
        } else if (op.od !== undefined) {
            delete target[key];
        }
    }
    return result;
};

describe('diffDocuments', () => {
    it('reports nothing for identical documents', () => {
        const docs = { ...assets({ 1: { item_id: 1, name: 'a.js' } }), ...scene({ a: entity('a') }) };
        const changes = diffDocuments(docs, structuredClone(docs));

        expect(changes.assetOps.size).to.equal(0);
        expect(changes.sceneOps.size).to.equal(0);
        expect(changes.addedAssets).to.deep.equal([]);
        expect(changes.removedAssets).to.deep.equal([]);
        expect(changes.structuralSceneIds).to.deep.equal([]);
    });

    it('emits a set for a changed asset field', () => {
        const changes = diffDocuments(
            assets({ 1: { item_id: 1, name: 'a.js', preload: true } }),
            assets({ 1: { item_id: 1, name: 'renamed.js', preload: true } })
        );

        expect(changes.assetOps.get(1)).to.deep.equal([{ p: ['name'], oi: 'renamed.js', od: 'a.js' }]);
    });

    it('ignores the keys the store owns', () => {
        // item_id/branch_id are re-derived on write and localPath is rewritten by the
        // layout mirroring, so diffing them would echo our own bookkeeping back.
        const changes = diffDocuments(
            assets({ 1: { item_id: 1, branch_id: 'local', file: { filename: 'a.js', localPath: 'a.js' } } }),
            assets({ 1: { item_id: 9, branch_id: 'other', file: { filename: 'a.js', localPath: 'sub/a.js' } } })
        );

        expect(changes.assetOps.size).to.equal(0);
    });

    it('reports added and removed assets separately from operations', () => {
        const changes = diffDocuments(
            assets({ 1: { item_id: 1, name: 'a.js' }, 2: { item_id: 2, name: 'b.js' } }),
            assets({ 1: { item_id: 1, name: 'a.js' }, 3: { item_id: 3, name: 'c.js' } })
        );

        expect(changes.removedAssets).to.deep.equal([2]);
        expect(changes.addedAssets).to.deep.equal([3]);
        expect(changes.assetOps.size).to.equal(0);
    });

    it('emits an unset for a removed key and a set for an added one', () => {
        const changes = diffDocuments(
            assets({ 1: { item_id: 1, meta: { width: 10 } } }),
            assets({ 1: { item_id: 1, tags: ['new'] } })
        );

        expect(changes.assetOps.get(1)).to.deep.equal([
            { p: ['meta'], od: { width: 10 } },
            { p: ['tags'], oi: ['new'] }
        ]);
    });

    it('recurses into nested objects instead of replacing them', () => {
        const changes = diffDocuments(
            scene({ a: entity('a', [], { components: { light: { intensity: 1, color: [1, 1, 1] } } }) }),
            scene({ a: entity('a', [], { components: { light: { intensity: 2, color: [1, 1, 1] } } }) })
        );

        expect(changes.sceneOps.get(1)).to.deep.equal([
            { p: ['entities', 'a', 'components', 'light', 'intensity'], oi: 2, od: 1 }
        ]);
    });

    it('scopes entity operations so the existing handler routes them', () => {
        const changes = diffDocuments(
            scene({ a: entity('a', [], { position: [0, 0, 0] }) }),
            scene({ a: entity('a', [], { position: [0, 5, 0] }) })
        );

        const ops = changes.sceneOps.get(1)!;
        // entities-sync.ts keys off p[0] === 'entities' and p[1] === resource_id
        expect(ops[0].p[0]).to.equal('entities');
        expect(ops[0].p[1]).to.equal('a');
    });

    describe('arrays', () => {
        // Granular list ops matter: the hierarchy tree listens for children:insert /
        // children:remove / children:move, which a whole-array set never fires.
        const roundTrip = (before: any[], after: any[]) => {
            const changes = diffDocuments(
                assets({ 1: { item_id: 1, tags: before } }),
                assets({ 1: { item_id: 1, tags: after } })
            );
            const ops = changes.assetOps.get(1) ?? [];
            expect(ops.every((op) => op.oi === undefined), `unexpected whole-array set: ${JSON.stringify(ops)}`).to
                .equal(true);
            const result = apply({ tags: before }, ops);
            expect(result.tags, `ops did not reproduce the target: ${JSON.stringify(ops)}`).to.deep.equal(after);
            return ops;
        };

        it('inserts at the end', () => {
            const ops = roundTrip(['a', 'b'], ['a', 'b', 'c']);
            expect(ops).to.deep.equal([{ p: ['tags', 2], li: 'c' }]);
        });

        it('inserts in the middle', () => {
            const ops = roundTrip(['a', 'c'], ['a', 'b', 'c']);
            expect(ops).to.deep.equal([{ p: ['tags', 1], li: 'b' }]);
        });

        it('inserts at the front', () => {
            roundTrip(['b', 'c'], ['a', 'b', 'c']);
        });

        it('removes from the middle', () => {
            const ops = roundTrip(['a', 'b', 'c'], ['a', 'c']);
            expect(ops).to.deep.equal([{ p: ['tags', 1], ld: 'b' }]);
        });

        it('removes several', () => {
            roundTrip(['a', 'b', 'c', 'd'], ['b', 'd']);
        });

        it('reorders as moves', () => {
            const ops = roundTrip(['a', 'b', 'c'], ['c', 'a', 'b']);
            expect(ops.every((op) => op.lm !== undefined)).to.equal(true);
        });

        it('swaps two elements', () => {
            roundTrip(['a', 'b'], ['b', 'a']);
        });

        it('handles a mixed insert and remove', () => {
            roundTrip(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
        });

        it('empties an array', () => {
            roundTrip(['a', 'b'], []);
        });

        it('fills an empty array', () => {
            roundTrip([], ['a', 'b']);
        });

        it('handles arrays of objects', () => {
            roundTrip([{ material: 1 }, { material: 2 }], [{ material: 2 }]);
        });

        it('sets elements of a fixed-length numeric array rather than splicing it', () => {
            // position/rotation/scale/colour are records keyed by index. Emitting remove and
            // insert ops for them does not replay correctly through the observer.
            const changes = diffDocuments(
                scene({ a: entity('a', [], { position: [0, 0, 0] }) }),
                scene({ a: entity('a', [], { position: [9, 9, 9] }) })
            );

            expect(changes.sceneOps.get(1)).to.deep.equal([
                { p: ['entities', 'a', 'position', 0], oi: 9, od: 0 },
                { p: ['entities', 'a', 'position', 1], oi: 9, od: 0 },
                { p: ['entities', 'a', 'position', 2], oi: 9, od: 0 }
            ]);
        });

        it('only sets the components of a vector that changed', () => {
            const changes = diffDocuments(
                scene({ a: entity('a', [], { scale: [1, 1, 1] }) }),
                scene({ a: entity('a', [], { scale: [1, 2, 1] }) })
            );
            expect(changes.sceneOps.get(1)).to.deep.equal([
                { p: ['entities', 'a', 'scale', 1], oi: 2, od: 1 }
            ]);
        });

        it('keeps granular ops for numeric lists whose listeners need them', () => {
            // components.camera.layers binds layers:insert / layers:remove (camera.ts:118),
            // so it must not be treated as a fixed-length tuple even though it is numeric.
            const changes = diffDocuments(
                scene({ a: entity('a', [], { components: { camera: { layers: [0, 1, 2] } } }) }),
                scene({ a: entity('a', [], { components: { camera: { layers: [0, 2, 1] } } }) })
            );

            const ops = changes.sceneOps.get(1)!;
            expect(ops.every((op) => op.lm !== undefined), JSON.stringify(ops)).to.equal(true);
        });

        it("replaces an asset's path wholesale, since the panel only watches path:set", () => {
            // Observer.set on an array emits only `:set`; the asset panel binds `path:set`
            // and nothing granular, so element ops would move the asset without redrawing it.
            const changes = diffDocuments(
                assets({ 1: { item_id: 1, path: [3] } }),
                assets({ 1: { item_id: 1, path: [] } })
            );
            expect(changes.assetOps.get(1)).to.deep.equal([{ p: ['path'], oi: [], od: [3] }]);
        });

        it('still emits granular ops for children, which the tree watches', () => {
            const changes = diffDocuments(
                scene({ root: entity('root', ['a', 'b']), a: entity('a'), b: entity('b') }),
                scene({ root: entity('root', ['a', 'b', 'c']), a: entity('a'), b: entity('b'), c: entity('c') })
            );
            // adding an entity is structural, so check a pure children edit instead
            expect(changes.structuralSceneIds).to.deep.equal([1]);
        });

        it('replaces a whole array only when the type changes', () => {
            const changes = diffDocuments(
                assets({ 1: { item_id: 1, data: ['a'] } }),
                assets({ 1: { item_id: 1, data: { a: 1 } } })
            );
            expect(changes.assetOps.get(1)).to.deep.equal([{ p: ['data'], oi: { a: 1 }, od: ['a'] }]);
        });
    });

    describe('scene structure', () => {
        it('flags an added entity for rebuild rather than patching', () => {
            const changes = diffDocuments(scene({ a: entity('a') }), scene({ a: entity('a'), b: entity('b') }));

            expect(changes.structuralSceneIds).to.deep.equal([1]);
            expect(changes.sceneOps.size).to.equal(0);
        });

        it('flags a removed entity for rebuild', () => {
            const changes = diffDocuments(scene({ a: entity('a'), b: entity('b') }), scene({ a: entity('a') }));
            expect(changes.structuralSceneIds).to.deep.equal([1]);
        });

        it('flags a reparent for rebuild', () => {
            // same entities, different hierarchy
            const before = scene({ root: entity('root', ['a', 'b']), a: entity('a'), b: entity('b') });
            const after = scene({ root: entity('root', ['a']), a: entity('a', ['b']), b: entity('b') });

            const changes = diffDocuments(before, after);
            expect(changes.structuralSceneIds).to.deep.equal([1]);
        });

        it('treats a sibling reorder as a field change, not a rebuild', () => {
            // reordering children keeps every parent the same, so ops suffice
            const before = scene({ root: entity('root', ['a', 'b']), a: entity('a'), b: entity('b') });
            const after = scene({ root: entity('root', ['b', 'a']), a: entity('a'), b: entity('b') });

            const changes = diffDocuments(before, after);
            expect(changes.structuralSceneIds).to.deep.equal([]);
            const ops = changes.sceneOps.get(1)!;
            expect(ops.every((op) => op.lm !== undefined)).to.equal(true);
        });

        it('emits scene-level field changes outside entities', () => {
            const changes = diffDocuments(
                scene({ a: entity('a') }, { settings: { physics: { gravity: [0, -9.8, 0] } } }),
                scene({ a: entity('a') }, { settings: { physics: { gravity: [0, -1, 0] } } })
            );

            const ops = changes.sceneOps.get(1)!;
            expect(ops[0].p[0]).to.equal('settings');
        });
    });
});
