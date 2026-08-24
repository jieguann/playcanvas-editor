type LocalAssetUpdates = Map<number, { path: number[]; localPath: string | null }>;

/**
 * Re-sync observers after the local store has rewritten the manifest. Both fields matter:
 * 'path' is what refreshes the asset panel, and 'file.localPath' must not be left stale
 * because it is in the editor's sync list and would be written back over the manifest.
 */
const applyLocalUpdates = (updates?: LocalAssetUpdates) => {
    for (const [id, update] of updates ?? []) {
        const asset = editor.call('assets:get', id);
        if (!asset) continue;
        const history = asset.history?.enabled;
        if (asset.history) asset.history.enabled = false;
        if (update.localPath !== null && asset.get('file')) {
            asset.set('file.localPath', update.localPath);
        }
        asset.set('path', update.path);
        if (asset.history) asset.history.enabled = history;
    }
};

editor.once('load', () => {
    const getIds = function (
        assets: { get: (path: string) => string | number } | { get: (path: string) => string | number }[]
    ) {
        if (!(assets instanceof Array)) {
            assets = [assets];
        }

        const ids = [];
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            ids.push(parseInt(String(asset.get('uniqueId')), 10));
        }

        return ids;
    };

    editor.method('assets:fs:delete', (assets) => {
        // Local mode has no backend to action the 'fs' message, so apply it directly.
        const localStore = editor.api.globals.localStore;
        if (localStore) {
            localStore
                .deleteAssetsRecursive(getIds(assets))
                .then((result: { removed: number[] }) => {
                    // Deleting a folder also removes its contents, so drop every id the
                    // store actually deleted rather than just the ones passed in.
                    for (const id of result.removed) {
                        const asset = editor.call('assets:get', id);
                        if (asset) editor.call('assets:remove', asset);
                    }
                })
                .catch((error: unknown) => {
                    console.error(error);
                    editor.call('status:error', 'Could not delete the asset.');
                });
            return;
        }

        editor.call('realtime:send', 'fs', {
            op: 'delete',
            ids: getIds(assets)
        });
    });

    editor.method('assets:fs:move', (assets, assetTo) => {
        const target = assetTo && parseInt(assetTo.get('id'), 10);

        // Get a list of esm scripts at the target location as a Map<name, asset>
        const esmScriptsAtTarget = editor.call('assets:list').reduce((map, asset) => {
            const path = asset.get('path').pop();

            const isSameFolder = (path ?? null) === (target ?? null);

            if (editor.call('assets:isModule', asset) && isSameFolder) {
                map.set(asset.get('name').toLowerCase(), asset);
            }
            return map;
        }, new Map());

        // Get a list of esm scripts that are being moved that match the names of the esm scripts at the target location
        const conflictingAssets = assets.filter((asset) => {
            return editor.call('assets:isModule', asset) && esmScriptsAtTarget.has(asset.get('name').toLowerCase());
        });

        // If there are conflicting ES Module assets, show an error message and return early
        if (conflictingAssets.length > 0) {
            const conflictingAssetNames = conflictingAssets.map((asset) => asset.get('name')).join(', ');
            const error = `The assets "${conflictingAssetNames}" already exist in this location. Move Aborted.`;
            editor.call('status:error', error);
            return error;
        }

        // Local mode has no backend to action the 'fs' message. Apply it to the manifest,
        // then set 'path' on each observer - that is what refreshes the panel and, via
        // ObserverSync, persists the change.
        const localStore = editor.api.globals.localStore;
        if (localStore) {
            localStore
                .moveAssets(getIds(assets), target || null)
                .then((result: { error?: string; updates?: LocalAssetUpdates }) => {
                    if (result.error) {
                        editor.call('status:error', result.error);
                        return;
                    }
                    applyLocalUpdates(result.updates);
                })
                .catch((error: unknown) => {
                    console.error(error);
                    editor.call('status:error', 'Could not move the asset.');
                });
            return null;
        }

        editor.call('realtime:send', 'fs', {
            op: 'move',
            ids: getIds(assets),
            to: assetTo ? parseInt(assetTo.get('uniqueId'), 10) : null
        });
        return null;
    });

    editor.method('assets:fs:duplicate', (assets) => {
        editor.call('realtime:send', 'fs', {
            op: 'duplicate',
            ids: getIds(assets)
        });
    });
});
