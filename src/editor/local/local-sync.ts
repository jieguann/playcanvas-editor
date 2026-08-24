import { config } from '@/editor/config';
import type { JsonOp, ManifestChanges } from '@/editor-api/local/manifest-diff';

/**
 * Live sync for standalone local mode.
 *
 * The project folder is the source of truth on disk, but the editor holds the whole project
 * in memory. Without this, a hand-edit to `playcanvas-project.json` is invisible to an open
 * editor and is then overwritten by its next save. The local server watches the folder and
 * pushes a notification; the store works out what changed, and this routes the result into
 * the same handlers the cloud editor uses for changes made by other people.
 */
editor.once('load', () => {
    const localStore = editor.api.globals.localStore;
    if (!localStore) {
        return;
    }

    const connection = editor.api.globals.realtime.connection as any;

    /** Deliver operations to a document so they arrive as an external change. */
    const applyTo = (collection: string, id: string, ops: JsonOp[]) => {
        const document = connection.documentFor?.(collection, id);
        if (!document?.data) {
            // Nothing has subscribed to this document yet, so there is no observer to update
            // and the store's copy is already current.
            return;
        }
        document.applyRemoteOp(ops);
    };

    const applyAssetChanges = (changes: ManifestChanges) => {
        for (const [id, ops] of changes.assetOps) {
            applyTo('assets', String(id), ops);
        }

        for (const id of changes.removedAssets) {
            const asset = editor.call('assets:get', id);
            if (!asset) continue;
            editor.call('selector:remove', asset);
            editor.call('assets:remove', asset);
        }

        for (const id of changes.addedAssets) {
            if (editor.call('assets:get', id)) continue;
            const asset = new editor.api.Asset({ id, uniqueId: id });
            asset.loadAndSubscribe()
                .then(() => editor.api.globals.assets.add(asset))
                .catch((error: unknown) => {
                    console.warn(`Could not add the asset added on disk (${id}).`, error);
                });
        }
    };

    const applySceneChanges = (changes: ManifestChanges, documents: Record<string, any>) => {
        const openScene = Number(config.scene?.id);

        for (const [id, ops] of changes.sceneOps) {
            applyTo('scenes', String(id), ops);
        }

        // An entity appearing, disappearing, or being reparented has to clear selection and
        // nullify references to it. Rebuilding from the raw scene does all of that, and is
        // what the editor already does when loading a scene.
        for (const id of changes.structuralSceneIds) {
            if (id !== openScene) continue;
            const scene = documents.scenes?.[String(id)];
            if (!scene) continue;
            editor.emit('scene:raw', scene);
        }
    };

    localStore.watchFolder(
        (changes: ManifestChanges, documents: Record<string, any>) => {
            try {
                applyAssetChanges(changes);
                applySceneChanges(changes, documents);
                editor.call('viewport:render');
            } catch (error) {
                console.error('Could not apply the change made in the project folder.', error);
                editor.call('status:error', 'Could not apply the change made in the project folder.');
            }
        },
        // An asset's bytes changed on disk. Pushing the new url at the observer is what makes
        // the engine drop the resource it decoded earlier and load the file again.
        (assetIds: number[]) => {
            for (const id of assetIds) {
                const asset = editor.call('assets:get', id);
                if (!asset) continue;
                const url = localStore.getFileUrl(id);
                if (!url) continue;
                const history = asset.history?.enabled;
                if (asset.history) asset.history.enabled = false;
                asset.set('file.url', url);
                if (asset.history) asset.history.enabled = history;
            }
            editor.call('viewport:render');
        }
    );

    // Both sides changed the same project, so the user picks which one survives rather than
    // either being discarded silently.
    localStore.on('conflict', (resolution: { keepEditor: () => Promise<void>; dismiss: () => void }) => {
        // 'Load From Disk' is the No button, which reports back through this event rather
        // than a callback.
        const onLoadFromDisk = () => {
            editor.unbind('picker:confirm:no', onLoadFromDisk);
            resolution.dismiss();
            // Reloading rebuilds every observer, panel, and cache from disk, which is safer
            // than reconciling state the editor has already moved past. Pending writes are
            // deliberately not flushed.
            window.location.reload();
        };
        editor.once('picker:confirm:no', onLoadFromDisk);

        editor.call(
            'picker:confirm',
            'This project folder was also changed outside the Editor. Keep your Editor changes, or load the version from disk?',
            () => {
                editor.unbind('picker:confirm:no', onLoadFromDisk);
                resolution.keepEditor().catch((error: unknown) => {
                    console.error(error);
                    editor.call('status:error', 'Could not save over the version on disk.');
                });
            },
            {
                yesText: 'Keep Editor Changes',
                noText: 'Load From Disk',
                noDismiss: true
            }
        );
    });
});
