const TEXT_TYPES = new Set(['css', 'html', 'json', 'script', 'shader', 'text']);

type LocalRenameUpdates = Map<number, { path: number[]; localPath: string | null }>;

editor.once('load', () => {
    const changeName = function (assetId: string | number, assetName: string, callback?: (error?: unknown) => void) {
        // Local mode has no REST backend. Write the manifest, move the payload to match the
        // new name, then set 'name' on the observer to refresh the panel.
        const localStore = editor.api.globals.localStore;
        if (localStore) {
            localStore
                .renameAsset(parseInt(String(assetId), 10), assetName)
                .then((result: { error?: string; updates?: LocalRenameUpdates }) => {
                    if (result.error) {
                        editor.call('status:error', `Couldn't update the name: ${result.error}`);
                        callback?.(result.error);
                        return;
                    }
                    // The payload may have moved, so re-sync localPath too - it is in the
                    // editor's sync list and a stale value would overwrite the manifest.
                    for (const [id, update] of result.updates ?? []) {
                        const affected = editor.call('assets:get', id);
                        if (!affected) continue;
                        const history = affected.history?.enabled;
                        if (affected.history) affected.history.enabled = false;
                        if (update.localPath !== null && affected.get('file')) {
                            affected.set('file.localPath', update.localPath);
                        }
                        if (id === parseInt(String(assetId), 10)) affected.set('name', assetName);
                        if (affected.history) affected.history.enabled = history;
                    }
                    callback?.();
                })
                .catch((error: unknown) => {
                    console.warn(`rename error: ${error}`);
                    editor.call('status:error', "Couldn't update the name.");
                    callback?.(error);
                });
            return;
        }

        editor.api.globals.rest.assets
            .assetUpdate(String(assetId), { name: assetName })
            .on('load', () => callback?.())
            .on('error', (err, data) => {
                console.warn(`rename error: ${err} ${data}`);
                editor.call('status:error', `Couldn't update the name: ${data}`);
                callback?.(data || err);
            });
    };

    const validate = (asset: any, newName: string) => {
        const id = asset.get('id');
        const type = asset.get('type');
        const path = asset.get('path');
        const parentId = path && path.length ? path[path.length - 1] : null;
        const enforceUnique = TEXT_TYPES.has(type) || type === 'folder';

        // reject if a sibling already has the new name (case-insensitive)
        if (enforceUnique) {
            const collision = editor.call('assets:list').some((item: any) => {
                if (item.get('id') === id) {
                    return false;
                }
                const itemPath = item.get('path');
                const itemParent = itemPath && itemPath.length ? itemPath[itemPath.length - 1] : null;
                if ((itemParent ?? null) !== (parentId ?? null)) {
                    return false;
                }
                return item.get('name').toLowerCase() === newName.toLowerCase();
            });

            if (collision) {
                return `An asset named "${newName}" already exists in this folder. Please choose a different name.`;
            }
        }
        return null;
    };

    editor.method('assets:rename:validate', validate);

    editor.method('assets:rename', (asset, newName, callback?: (error?: unknown) => void) => {
        const oldName = asset.get('name');
        const id = asset.get('id');
        const error = validate(asset, newName);
        if (error) {
            return error;
        }

        editor.api.globals.history?.add({
            name: 'asset rename',
            combine: false,
            undo: function () {
                if (editor.call('assets:get', id)) {
                    changeName(id, oldName);
                }
            },
            redo: function () {
                if (editor.call('assets:get', id)) {
                    changeName(id, newName);
                }
            }
        });

        changeName(id, newName, callback);
        return null;
    });
});
