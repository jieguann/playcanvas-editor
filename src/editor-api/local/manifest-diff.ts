/**
 * Turns two manifest snapshots into json0 operations.
 *
 * Standalone local mode has no backend to compute operations, so when the project folder
 * changes on disk the store diffs the old documents against the new ones and feeds the
 * result into the editor's existing inbound op path (`ObserverSync.write`, and the
 * `realtime:scene:op:*` / `realtime:op:assets` handlers).
 *
 * `src/common/diff.ts` is deliberately not reused: it produces a human-readable shape
 * (`key__added`, `__old`/`__new`) for the version-control UI, which discards the positional
 * indices json0 list operations need.
 */

type JsonOp = {
    p: (string | number)[];
    oi?: any;
    od?: any;
    li?: any;
    ld?: any;
    lm?: number;
};

type Documents = Record<string, Record<string, Record<string, any>>>;

type ManifestChanges = {
    /** Operations per asset id, with paths relative to the asset document. */
    assetOps: Map<number, JsonOp[]>;
    /** Assets whose documents appeared or disappeared. */
    addedAssets: number[];
    removedAssets: number[];
    /** Operations per scene id, with paths relative to the scene document. */
    sceneOps: Map<number, JsonOp[]>;
    /**
     * Scenes whose entity set or hierarchy changed. These are rebuilt wholesale rather than
     * patched, because entity teardown has to clear selection and nullify cross-entity
     * references - work the existing `scene:raw` path already does correctly.
     */
    structuralSceneIds: number[];
};

/** Keys the store owns; diffing them would echo our own bookkeeping back at the editor. */
const IGNORED_KEYS = new Set(['item_id', 'branch_id', 'url', 'localPath']);

/**
 * Arrays that must be replaced wholesale rather than patched element by element.
 *
 * `Observer.set` on an array emits only `<path>:set`, while `insert`/`remove`/`move` emit
 * the granular events. Listeners are split on which they bind, so the op has to match:
 * the asset panel watches `path:set` alone (`asset-panel.ts:1875`), whereas the hierarchy
 * tree watches `children:insert`/`:remove`/`:move` and never `children:set`
 * (`entities-treeview.ts:769,789,800`). Verified against the observer directly.
 */
const WHOLE_ARRAY_PATHS = new Set(['path']);

const isWholeArrayPath = (path: (string | number)[]) => {
    const key = path[path.length - 1];
    return typeof key === 'string' && WHOLE_ARRAY_PATHS.has(key);
};

/**
 * Fields that are fixed-length tuples rather than lists.
 *
 * Index is identity for these, so a changed component is a set. Numeric lists that really
 * are lists - `layers`, `scripts` - are excluded, because their listeners bind the granular
 * `:insert`/`:remove` events (`camera.ts:118`, `settings-panels/scripts.ts:47`).
 */
const VECTOR_KEYS = new Set([
    'position',
    'rotation',
    'scale',
    'localPosition',
    'localRotation',
    'localScale',
    'color',
    'clearColor',
    'ambientColor',
    'fogColor',
    'skyboxRotation',
    'offset',
    'margin',
    'anchor',
    'pivot',
    'alignment',
    'spacing',
    'gravity',
    'linearFactor',
    'angularFactor',
    'halfExtents',
    'lightMapSizeMultiplier',
    'area'
]);

const isVectorPath = (path: (string | number)[]) => {
    const key = path[path.length - 1];
    return typeof key === 'string' && VECTOR_KEYS.has(key);
};

const isObject = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);

const equal = (a: any, b: any) => {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (!a || !b || typeof a !== 'object') return false;
    return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Diff two arrays into granular list operations.
 *
 * Whole-array replacement is not an option: the hierarchy tree listens for
 * `children:insert` / `children:remove` / `children:move`, which a plain set never fires.
 * A longest-common-subsequence walk keeps the emitted indices meaningful, and a pure
 * reorder of the same members collapses to `lm` moves.
 */
const diffArray = (previous: any[], next: any[], path: (string | number)[]): JsonOp[] => {
    // Fixed-length tuples - positions, rotations, colours - are records with a field per
    // index, not lists. Index is identity, so set the elements that differ: treating them as
    // a list produces remove/insert churn the observer cannot replay.
    const numeric = (value: any[]) => value.every((item) => typeof item === 'number' || item === null);
    if (previous.length === next.length && isVectorPath(path) && numeric(previous) && numeric(next)) {
        const ops: JsonOp[] = [];
        for (let index = 0; index < next.length; index++) {
            if (!equal(previous[index], next[index])) {
                ops.push({ p: [...path, index], oi: next[index], od: previous[index] });
            }
        }
        return ops;
    }

    // Same members in a different order: express it as moves so listeners can follow.
    const sameMembers =
        previous.length === next.length &&
        previous.every((item) => next.some((other) => equal(item, other))) &&
        next.every((item) => previous.some((other) => equal(item, other)));

    if (sameMembers) {
        const ops: JsonOp[] = [];
        const working = [...previous];
        for (let target = 0; target < next.length; target++) {
            if (equal(working[target], next[target])) continue;
            const from = working.findIndex((item, index) => index > target && equal(item, next[target]));
            if (from === -1) continue;
            working.splice(target, 0, working.splice(from, 1)[0]);
            ops.push({ p: [...path, from], lm: target });
        }
        return ops;
    }

    // Longest common subsequence over the two arrays, so surviving elements are left alone.
    const rows = previous.length;
    const columns = next.length;
    const lengths: number[][] = Array.from({ length: rows + 1 }, () => new Array(columns + 1).fill(0));
    for (let row = rows - 1; row >= 0; row--) {
        for (let column = columns - 1; column >= 0; column--) {
            lengths[row][column] = equal(previous[row], next[column])
                ? lengths[row + 1][column + 1] + 1
                : Math.max(lengths[row + 1][column], lengths[row][column + 1]);
        }
    }

    const ops: JsonOp[] = [];
    let index = 0; // index into the array as it exists while operations are applied
    let row = 0;
    let column = 0;
    while (row < rows && column < columns) {
        if (equal(previous[row], next[column])) {
            index++;
            row++;
            column++;
        } else if (lengths[row + 1][column] >= lengths[row][column + 1]) {
            ops.push({ p: [...path, index], ld: previous[row] });
            row++;
        } else {
            ops.push({ p: [...path, index], li: next[column] });
            index++;
            column++;
        }
    }
    while (row < rows) {
        ops.push({ p: [...path, index], ld: previous[row] });
        row++;
    }
    while (column < columns) {
        ops.push({ p: [...path, index], li: next[column] });
        index++;
        column++;
    }
    return ops;
};

/** Diff two JSON values, appending operations for every difference found. */
const diffValue = (previous: any, next: any, path: (string | number)[], ops: JsonOp[]) => {
    if (equal(previous, next)) return;

    if (Array.isArray(previous) && Array.isArray(next)) {
        if (isWholeArrayPath(path)) {
            ops.push({ p: [...path], oi: next, od: previous });
        } else {
            ops.push(...diffArray(previous, next, path));
        }
        return;
    }

    if (isObject(previous) && isObject(next)) {
        for (const key of Object.keys(previous)) {
            if (IGNORED_KEYS.has(key)) continue;
            if (Object.prototype.hasOwnProperty.call(next, key)) continue;
            ops.push({ p: [...path, key], od: previous[key] });
        }
        for (const key of Object.keys(next)) {
            if (IGNORED_KEYS.has(key)) continue;
            if (Object.prototype.hasOwnProperty.call(previous, key)) {
                diffValue(previous[key], next[key], [...path, key], ops);
            } else {
                ops.push({ p: [...path, key], oi: next[key] });
            }
        }
        return;
    }

    // Scalar change, or a type change between scalar/object/array.
    ops.push({ p: [...path], oi: next, od: previous });
};

/**
 * Every entity's parent, so a reparent can be told apart from a field edit.
 *
 * Derived from `children` rather than each entity's own `parent`: the child lists are what
 * the hierarchy is actually built from, and reading `parent` as well would let iteration
 * order overwrite a derived parent with a stale one.
 */
const parentsOf = (entities: Record<string, any>) => {
    const parents = new Map<string, string | null>();
    for (const resourceId of Object.keys(entities || {})) parents.set(resourceId, null);
    for (const [resourceId, entity] of Object.entries(entities || {})) {
        for (const child of entity?.children || []) parents.set(String(child), resourceId);
    }
    return parents;
};

/**
 * Compare two sets of manifest documents.
 *
 * @param previous - The documents the editor currently holds.
 * @param next - The documents just read from disk.
 * @returns The operations to apply, plus anything that needs a wholesale rebuild.
 */
const diffDocuments = (previous: Documents, next: Documents): ManifestChanges => {
    const changes: ManifestChanges = {
        assetOps: new Map(),
        addedAssets: [],
        removedAssets: [],
        sceneOps: new Map(),
        structuralSceneIds: []
    };

    const previousAssets = previous.assets || {};
    const nextAssets = next.assets || {};

    for (const id of Object.keys(previousAssets)) {
        if (!nextAssets[id]) changes.removedAssets.push(Number(id));
    }

    for (const [id, asset] of Object.entries(nextAssets)) {
        const before = previousAssets[id];
        if (!before) {
            changes.addedAssets.push(Number(id));
            continue;
        }
        const ops: JsonOp[] = [];
        diffValue(before, asset, [], ops);
        if (ops.length) changes.assetOps.set(Number(id), ops);
    }

    const previousScenes = previous.scenes || {};
    const nextScenes = next.scenes || {};

    for (const [id, scene] of Object.entries(nextScenes)) {
        const before = previousScenes[id];
        if (!before) continue;

        const beforeEntities = before.entities || {};
        const afterEntities = scene.entities || {};
        const beforeIds = Object.keys(beforeEntities);
        const afterIds = Object.keys(afterEntities);

        const beforeParents = parentsOf(beforeEntities);
        const afterParents = parentsOf(afterEntities);
        const structural =
            beforeIds.length !== afterIds.length ||
            beforeIds.some((resourceId) => !afterEntities[resourceId]) ||
            afterIds.some((resourceId) => beforeParents.get(resourceId) !== afterParents.get(resourceId));

        if (structural) {
            changes.structuralSceneIds.push(Number(id));
            continue;
        }

        // Entity set and hierarchy match, so only field-level operations are needed.
        const ops: JsonOp[] = [];
        for (const key of Object.keys(scene)) {
            if (IGNORED_KEYS.has(key)) continue;
            if (key === 'entities') {
                for (const resourceId of afterIds) {
                    diffValue(beforeEntities[resourceId], afterEntities[resourceId], ['entities', resourceId], ops);
                }
            } else {
                diffValue(before[key], scene[key], [key], ops);
            }
        }
        if (ops.length) changes.sceneOps.set(Number(id), ops);
    }

    return changes;
};

export { diffDocuments, type JsonOp, type ManifestChanges };
