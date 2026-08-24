import { expect } from 'chai';
import { beforeEach, describe, it } from 'mocha';

import { LocalProjectStore } from '../../src/editor-api/local/project-store';

type Manifest = { documents: Record<string, Record<string, any>> };

const asset = (id: number, name: string, path: number[], localPath: string | null) => ({
    item_id: id,
    branch_id: 'local',
    name,
    type: localPath === null ? 'folder' : 'script',
    path,
    file: localPath === null ? null : { filename: name, localPath, size: 1, hash: '', variants: null }
});

/**
 * Backs the store with an in-memory `assets/` directory so the real fetch-based file
 * handling is exercised, mirroring what scripts/local-server.mjs does on disk.
 */
const install = (manifest: Manifest) => {
    const files = new Map<string, string>();
    const prefix = '/local-api/projects/test/assets/';

    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const ok = (body: any = {}) => ({ ok: true, status: 200, json: async () => body });

        if (url.endsWith('/manifest')) {
            if (method === 'PUT') {
                Object.assign(manifest, JSON.parse(init.body));
                return ok({ saved: true });
            }
            return ok(manifest);
        }

        const name = decodeURIComponent(url.slice(prefix.length));
        if (method === 'PUT') {
            files.set(name, String(init.body));
            return ok({ saved: true });
        }
        if (method === 'DELETE') {
            files.delete(name);
            return ok();
        }
        if (!files.has(name)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, blob: async () => files.get(name) };
    }) as any;

    const store = new LocalProjectStore({
        enabled: true,
        projectName: 'test',
        directoryId: 'test',
        documents: {}
    });

    return { store, files, manifest };
};

const layout = (files: Map<string, string>) => [...files.keys()].sort();
const pathOf = (manifest: Manifest, id: number) => manifest.documents.assets[String(id)].path;
const localPathOf = (manifest: Manifest, id: number) =>
    manifest.documents.assets[String(id)].file?.localPath ?? null;

describe('LocalProjectStore asset layout', () => {
    let ctx: ReturnType<typeof install>;

    beforeEach(() => {
        ctx = install({
            documents: {
                assets: {
                    1: asset(1, 'rotate.js', [], '1-rotate.js'),
                    2: asset(2, 'color-cycle.js', [], '2-color-cycle.js'),
                    3: asset(3, 'folder', [], null),
                    4: asset(4, 'test.js', [3], '4-test.js')
                }
            }
        });
        ctx.files.set('1-rotate.js', 'rotate');
        ctx.files.set('2-color-cycle.js', 'cycle');
        ctx.files.set('4-test.js', 'test');
    });

    it('migrates a flat layout to mirror the editor folders on open', async () => {
        await ctx.store.initialize();

        expect(layout(ctx.files)).to.deep.equal(['color-cycle.js', 'folder/test.js', 'rotate.js']);
        expect(localPathOf(ctx.manifest, 4)).to.equal('folder/test.js');
        expect(ctx.store.getFileUrl(4)).to.contain('folder%2Ftest.js');
        // contents must survive the move
        expect(ctx.files.get('folder/test.js')).to.equal('test');
    });

    it('moves an asset into a folder', async () => {
        await ctx.store.initialize();
        const result = await ctx.store.moveAssets([1], 3);

        expect(result.error).to.equal(undefined);
        expect(pathOf(ctx.manifest, 1)).to.deep.equal([3]);
        expect(localPathOf(ctx.manifest, 1)).to.equal('folder/rotate.js');
        // callers need the new localPath to re-sync the observer, or it writes back a stale one
        expect(result.updates?.get(1)).to.deep.equal({ path: [3], localPath: 'folder/rotate.js' });
        expect(layout(ctx.files)).to.deep.equal([
            'color-cycle.js',
            'folder/rotate.js',
            'folder/test.js'
        ]);
    });

    it('moves an asset back out to the project root', async () => {
        await ctx.store.initialize();
        await ctx.store.moveAssets([4], null);

        expect(pathOf(ctx.manifest, 4)).to.deep.equal([]);
        expect(layout(ctx.files)).to.deep.equal(['color-cycle.js', 'rotate.js', 'test.js']);
    });

    it('carries folder contents and relative depth when a folder moves', async () => {
        // folder(3)/inner(5)/deep.js(6) -> move 3 under outer(7)
        ctx.manifest.documents.assets[5] = asset(5, 'inner', [3], null);
        ctx.manifest.documents.assets[6] = asset(6, 'deep.js', [3, 5], '6-deep.js');
        ctx.manifest.documents.assets[7] = asset(7, 'outer', [], null);
        ctx.files.set('6-deep.js', 'deep');

        await ctx.store.initialize();
        expect(localPathOf(ctx.manifest, 6)).to.equal('folder/inner/deep.js');

        await ctx.store.moveAssets([3], 7);

        expect(pathOf(ctx.manifest, 3)).to.deep.equal([7]);
        expect(pathOf(ctx.manifest, 5)).to.deep.equal([7, 3]);
        expect(pathOf(ctx.manifest, 6)).to.deep.equal([7, 3, 5]);
        expect(localPathOf(ctx.manifest, 6)).to.equal('outer/folder/inner/deep.js');
        expect(ctx.files.get('outer/folder/inner/deep.js')).to.equal('deep');
    });

    it('refuses to move a folder into itself or its own descendant', async () => {
        ctx.manifest.documents.assets[5] = asset(5, 'inner', [3], null);
        await ctx.store.initialize();
        const before = layout(ctx.files);

        expect((await ctx.store.moveAssets([3], 3)).error).to.be.a('string');
        expect((await ctx.store.moveAssets([3], 5)).error).to.be.a('string');
        expect(pathOf(ctx.manifest, 3)).to.deep.equal([]);
        expect(layout(ctx.files)).to.deep.equal(before);
    });

    it('does not flatten a child selected alongside its own folder', async () => {
        await ctx.store.initialize();
        // asset 4 lives in folder 3; moving both to root must keep 4 inside 3
        await ctx.store.moveAssets([3, 4], null);

        expect(pathOf(ctx.manifest, 3)).to.deep.equal([]);
        expect(pathOf(ctx.manifest, 4)).to.deep.equal([3]);
        expect(localPathOf(ctx.manifest, 4)).to.equal('folder/test.js');
    });

    it('renames an asset and moves its payload to match', async () => {
        await ctx.store.initialize();
        await ctx.store.renameAsset(1, 'spin.js');

        expect(ctx.manifest.documents.assets['1'].name).to.equal('spin.js');
        expect(localPathOf(ctx.manifest, 1)).to.equal('spin.js');
        expect(ctx.files.get('spin.js')).to.equal('rotate');
        expect(ctx.files.has('rotate.js')).to.equal(false);
    });

    it('leaves file.filename to the editor when renaming', async () => {
        // 'file' is in the editor's sync list, so an observer holding the old filename writes
        // it back over the manifest; the disk name must follow 'name', not 'file.filename'.
        await ctx.store.initialize();
        await ctx.store.renameAsset(1, 'spin.js');
        ctx.manifest.documents.assets['1'].file.filename = 'rotate.js';

        const reopened = install(ctx.manifest);
        for (const [name, body] of ctx.files) reopened.files.set(name, body);
        await reopened.store.initialize();

        expect(localPathOf(reopened.manifest, 1)).to.equal('spin.js');
        expect(reopened.files.has('spin.js')).to.equal(true);
        expect(reopened.files.has('rotate.js')).to.equal(false);
    });

    it('renames a folder and relocates everything inside it', async () => {
        await ctx.store.initialize();
        await ctx.store.renameAsset(3, 'scripts');

        expect(localPathOf(ctx.manifest, 4)).to.equal('scripts/test.js');
        expect(ctx.files.get('scripts/test.js')).to.equal('test');
        expect(ctx.files.has('folder/test.js')).to.equal(false);
    });

    it('keeps same-named siblings distinct and stable across reloads', async () => {
        // two assets named test.js in the same folder
        ctx.manifest.documents.assets[8] = asset(8, 'test.js', [3], '8-test.js');
        ctx.files.set('8-test.js', 'other');

        await ctx.store.initialize();
        const first = layout(ctx.files);

        expect(first).to.contain('folder/test.js');
        expect(first).to.contain('folder/8-test.js');
        expect(localPathOf(ctx.manifest, 4)).to.equal('folder/test.js');
        expect(localPathOf(ctx.manifest, 8)).to.equal('folder/8-test.js');

        // reopening must not shuffle the winner
        const reopened = install(ctx.manifest);
        for (const [name, body] of ctx.files) reopened.files.set(name, body);
        await reopened.store.initialize();
        expect(layout(reopened.files)).to.deep.equal(first);
    });

    it('keeps the file extension when a rename drops it', async () => {
        // the extension selects the loader and the server's Content-Type
        await ctx.store.initialize();
        await ctx.store.renameAsset(1, 'spin');

        expect(localPathOf(ctx.manifest, 1)).to.equal('spin.js');
        expect(ctx.files.get('spin.js')).to.equal('rotate');
    });

    it('never overwrites a sibling whose filename it is taking', async () => {
        // Renaming asset 1 to a name asset 2 already holds on disk must not clobber it.
        await ctx.store.initialize();
        await ctx.store.renameAsset(1, 'color-cycle.js');

        expect([...ctx.files.values()].sort()).to.deep.equal(['cycle', 'rotate', 'test']);
        expect(ctx.files.get('color-cycle.js')).to.equal('cycle');
        expect(localPathOf(ctx.manifest, 2)).to.equal('color-cycle.js');
        expect(localPathOf(ctx.manifest, 1)).to.equal('1-color-cycle.js');
        expect(ctx.files.get('1-color-cycle.js')).to.equal('rotate');
    });

    it('deletes a folder together with its contents', async () => {
        ctx.manifest.documents.assets[5] = asset(5, 'inner', [3], null);
        ctx.manifest.documents.assets[6] = asset(6, 'deep.js', [3, 5], '6-deep.js');
        ctx.files.set('6-deep.js', 'deep');

        await ctx.store.initialize();
        const result = await ctx.store.deleteAssetsRecursive([3]);

        // the caller needs every removed id to clear the panel, not just the folder
        expect([...result.removed].sort((a, b) => a - b)).to.deep.equal([3, 4, 5, 6]);
        for (const id of [3, 4, 5, 6]) {
            expect(ctx.manifest.documents.assets[String(id)], `asset ${id}`).to.equal(undefined);
        }
        expect(ctx.manifest.documents.assets['1']).to.not.equal(undefined);
        expect(layout(ctx.files)).to.deep.equal(['color-cycle.js', 'rotate.js']);
    });
});
