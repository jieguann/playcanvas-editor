import { Events } from '@playcanvas/observer';

import { diffDocuments } from './manifest-diff';

type Documents = Record<string, Record<string, Record<string, any>>>;

type LocalLightEntity = {
    name?: string;
    components?: {
        light?: {
            type?: string;
            castShadows?: boolean;
            shadowBias?: number;
            normalOffsetBias?: number;
        };
    };
};

type LocalProjectOptions = {
    enabled: boolean;
    projectName: string;
    directoryId: string;
    documents: Documents;
};

const clone = <T>(value: T): T => structuredClone(value);
const safeFilename = (value: string) =>
    Array.from(value, (character) =>
        character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character
    )
        .join('')
        .replace(/[. ]+$/g, '') || 'asset';

/**
 * Asset names are free-form, but the extension is what selects a loader (and the local
 * server's Content-Type), so keep the uploaded file's extension when the name drops it.
 */
const withExtension = (name: string | undefined, filename: string | undefined, id: number) => {
    const base = name || filename || `asset-${id}`;
    const extension = /(\.[^./\\]+)$/.exec(filename || '')?.[1];
    if (!extension || base.toLowerCase().endsWith(extension.toLowerCase())) return base;
    return `${base}${extension}`;
};

/** Storage for a standalone project folder containing a JSON manifest and asset files. */
class LocalProjectStore extends Events {
    private _defaults: Documents;

    private _projectName: string;

    private _directoryId: string;

    private _documents: Documents = {};

    private _fileUrls = new Map<number, string>();

    private _ready: Promise<void> | null = null;

    private _writeQueue = Promise.resolve();

    /** Hash of the manifest as last read or written, used to detect outside changes. */
    private _revision: string | null = null;

    private _eventStream: EventSource | null = null;

    private _conflict = false;

    /** Cache-busting counter per asset file, bumped when the file changes on disk. */
    private _fileVersions = new Map<string, number>();

    /**
     * Documents this client changed since its last accepted write, as `collection/id`. Used
     * to tell a harmless interleave from a real overlap when another writer got there first.
     */
    private _touched = new Set<string>();

    private _externalApply: ((changes: ReturnType<typeof diffDocuments>, documents: Documents) => void) | null = null;

    /** The documents as last accepted by the server, the base for merge decisions. */
    private _writtenDocuments: Documents | null = null;

    constructor(options: LocalProjectOptions) {
        super();
        this._projectName = options.projectName;
        this._directoryId = options.directoryId;
        this._defaults = clone(options.documents || {});
    }

    initialize() {
        if (!this._ready) {
            this._ready = this._initialize();
        }
        return this._ready;
    }

    async flush() {
        await this._writeQueue;
    }

    private async _initialize() {
        await this._initializeFolder();

        // New document types added by later editor versions should be available
        // without overwriting anything the user has already saved.
        for (const [collection, documents] of Object.entries(this._defaults)) {
            this._documents[collection] ??= {};
            for (const [id, data] of Object.entries(documents)) {
                this._documents[collection][id] ??= clone(data);
            }
        }

        this._migrateStarterLights();

        await this._readFolderAssetFiles();
        await this._migrateAssetLayout();
        await this._writeFolderDocuments(this._documents);
    }

    private async _initializeFolder() {
        const response = await fetch(this._folderUrl('/manifest'));
        if (response.status === 404) {
            this._documents = clone(this._defaults);
            return;
        }
        if (!response.ok) throw new Error(`Could not open the project folder (${response.status}).`);
        const storedProject = await response.json();
        this._revision = storedProject.revision ?? null;
        this._documents = storedProject.documents || storedProject;
        this._writtenDocuments = clone(this._documents);
    }

    private async _readFolderAssetFiles() {
        for (const asset of Object.values(this._documents.assets || {})) {
            const id = Number(asset.item_id);
            const localPath = asset.file?.localPath;
            if (!id || !localPath) continue;
            this._fileUrls.set(id, this._assetFileUrl(localPath));
        }
    }

    private _folderUrl(path: string) {
        return `/local-api/projects/${encodeURIComponent(this._directoryId)}${path}`;
    }

    private _assetFileUrl(localPath: string) {
        const version = this._fileVersions.get(localPath);
        const url = this._folderUrl(`/assets/${encodeURIComponent(localPath)}`);
        // A changed file needs a changed url, or the engine keeps the resource it already
        // decoded (a texture, a model) and the viewport shows the old bytes.
        return version ? `${url}?v=${version}` : url;
    }

    /**
     * Note that asset payloads changed on disk and hand back the ids affected, so the editor
     * can refresh what it has already loaded.
     */
    private _bumpFileVersions(paths: string[]) {
        const ids: number[] = [];
        for (const [id, asset] of Object.entries(this._documents.assets || {})) {
            const localPath = asset.file?.localPath;
            if (!localPath || !paths.includes(localPath)) continue;
            this._fileVersions.set(localPath, (this._fileVersions.get(localPath) || 0) + 1);
            this._fileUrls.set(Number(id), this._assetFileUrl(localPath));
            ids.push(Number(id));
        }
        return ids;
    }

    /** Directory segments for an asset, mirroring the editor's folder names. */
    private _folderSegments(path: unknown) {
        if (!Array.isArray(path)) return [];
        const segments: string[] = [];
        for (const folderId of path) {
            const folder = this._documents.assets?.[String(folderId)];
            if (folder) segments.push(safeFilename(folder.name || `folder-${folderId}`));
        }
        return segments;
    }

    /**
     * Where an asset's payload belongs on disk, mirroring the editor's folder tree. The
     * editor allows two assets to share a name in one folder, so only one of them can hold
     * the plain filename; the rest fall back to an `<id>-` prefix, which is unique and
     * stable across reloads. An asset never takes a name that is currently on disk for
     * another asset - that would overwrite it.
     */
    private _desiredLocalPath(id: number, asset: Record<string, any>) {
        if (!asset?.file?.localPath) return null;
        const leaf = safeFilename(withExtension(asset.name, asset.file.filename, id));
        const directory = this._folderSegments(asset.path).join('/');
        const withDirectory = (filename: string) =>
            directory ? `${directory}/${filename}` : filename;
        const prefixed = withDirectory(`${id}-${leaf}`);
        const plain = withDirectory(leaf);

        for (const other of Object.values(this._documents.assets || {})) {
            const otherId = Number(other.item_id);
            if (!other.file?.localPath || otherId === id) continue;
            // Somebody else is already parked on the plain name; leave it alone.
            if (other.file.localPath === plain) return prefixed;
            if (this._folderSegments(other.path).join('/') !== directory) continue;
            // Same desired name in the same folder: the lowest id wins it.
            const otherLeaf = safeFilename(withExtension(other.name, other.file.filename, otherId));
            if (otherLeaf === leaf && otherId < id) return prefixed;
        }

        return plain;
    }

    /**
     * Move an asset's payload to `to`, keeping the manifest and url map in step. Layout is
     * a convenience: on failure the file keeps its old location rather than going missing.
     */
    private async _relocateAssetFile(id: number, from: string, to: string) {
        if (from === to) return;
        try {
            const source = await fetch(this._assetFileUrl(from));
            if (!source.ok) throw new Error(`could not read the asset file (${source.status})`);
            const blob = await source.blob();

            const written = await fetch(this._assetFileUrl(to), { method: 'PUT', body: blob });
            if (!written.ok) throw new Error(`could not write the asset file (${written.status})`);

            const asset = this._documents.assets?.[String(id)];
            if (asset?.file) asset.file.localPath = to;
            this._fileUrls.set(id, this._assetFileUrl(to));

            await fetch(this._assetFileUrl(from), { method: 'DELETE' });
        } catch (error) {
            console.warn(`Could not move the local asset file to "${to}".`, error);
        }
    }

    /** Realign every asset payload with the editor's folder tree. */
    private async _syncAssetFileLayout(ids?: number[]) {
        const assets = this._documents.assets || {};
        const targets = ids ?? Object.values(assets).map((asset) => Number(asset.item_id));
        let moved = false;
        for (const id of targets) {
            const asset = assets[String(id)];
            const from = asset?.file?.localPath;
            if (!from) continue;
            const to = this._desiredLocalPath(id, asset);
            if (!to || to === from) continue;
            await this._relocateAssetFile(id, from, to);
            moved = true;
        }
        if (moved) this._persist();
    }

    /** Ids of `id` and every asset beneath it, deepest first so files clear before folders. */
    private _withDescendants(ids: number[]) {
        const assets = Object.values(this._documents.assets || {});
        const collected = new Set<number>();
        const walk = (parentId: number) => {
            for (const asset of assets) {
                const childId = Number(asset.item_id);
                if (collected.has(childId)) continue;
                if ((asset.path?.at(-1) ?? null) !== parentId) continue;
                collected.add(childId);
                walk(childId);
            }
        };
        for (const id of ids) {
            collected.add(id);
            walk(id);
        }
        return [...collected].sort((a, b) => {
            const depth = (value: number) =>
                this._documents.assets?.[String(value)]?.path?.length ?? 0;
            return depth(b) - depth(a);
        });
    }

    /**
     * Older projects stored every payload flat as `<id>-<name>`. Mirror the editor's folder
     * tree instead, once, on open. Layout is a convenience, so a failure here must never
     * stop a project from opening.
     */
    private async _migrateAssetLayout() {
        try {
            await this._syncAssetFileLayout();
        } catch (error) {
            console.warn('Could not update the local asset folder layout.', error);
        }
    }

    /** Update the original local starter light without overwriting user-tuned lights. */
    private _migrateStarterLights() {
        for (const scene of Object.values(this._documents.scenes || {})) {
            for (const entity of Object.values(scene.entities || {}) as LocalLightEntity[]) {
                const light = entity.components?.light;
                const isOriginalStarterLight =
                    entity.name === 'Light' &&
                    light?.type === 'directional' &&
                    light.castShadows === true &&
                    light.shadowBias === 0.05 &&
                    light.normalOffsetBias === 0;

                if (isOriginalStarterLight) {
                    light.shadowBias = 0.2;
                    light.normalOffsetBias = 0.05;
                }
            }
        }
    }

    private _persist() {
        // While a conflict is unresolved every queued write is built from a base the folder
        // has already moved past, so writing would destroy the change we are asking about.
        if (this._conflict) return;

        const snapshot = clone(this._documents);
        this._writeQueue = this._writeQueue
            .then(() => this._writeFolderDocuments(snapshot))
            .catch((error) => console.error('Could not save the local folder project.', error));
    }

    private async _writeFolderDocuments(documents: Documents, force = false) {
        const response = await fetch(this._folderUrl('/manifest'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                format: 'playcanvas-local-project',
                version: 1,
                name: this._projectName,
                documents,
                baseRevision: force ? undefined : (this._revision ?? undefined)
            })
        });

        if (response.status === 409) {
            // The folder moved on underneath us. Let whoever is listening decide rather than
            // discarding either side's work. The revision is deliberately left alone until
            // the user chooses, so nothing queued can succeed in the meantime.
            const conflict = await response.json().catch(() => ({}));
            const serverRevision = conflict.revision ?? null;

            // A second tab, or a hand-edit elsewhere in the project, is not a conflict unless
            // it touched something this client also changed.
            if (await this._tryMergeExternalChange()) {
                await this._writeFolderDocuments(clone(this._documents));
                return;
            }

            if (!this._conflict) {
                this._conflict = true;
                this.emit('conflict', {
                    keepEditor: async () => {
                        this._conflict = false;
                        // Adopt the folder's revision so this write is accepted, then push
                        // the editor's version over it.
                        if (serverRevision) this._revision = serverRevision;
                        await this._writeFolderDocuments(clone(this._documents), true);
                    },
                    dismiss: () => {
                        this._conflict = false;
                    }
                });
            }
            return;
        }

        if (!response.ok) throw new Error(`Could not save the project folder (${response.status}).`);
        const saved = await response.json().catch(() => ({}));
        if (saved.revision) this._revision = saved.revision;
        this._writtenDocuments = clone(documents);
        this._touched.clear();
    }

    /**
     * Fold in a change another writer made, when it does not overlap what this client changed.
     *
     * Two editor tabs on one folder interleave constantly - each holds its own copy, so the
     * second to save is always working from a stale revision even when the two edited
     * different things. Merging those silently keeps both, and only a genuine overlap is
     * worth interrupting anyone about.
     *
     * @returns Whether the change was merged, leaving the caller free to retry its write.
     */
    private async _tryMergeExternalChange() {
        const response = await fetch(this._folderUrl('/manifest'));
        if (!response.ok) return false;
        const stored = await response.json();
        const next: Documents = stored.documents || stored;

        // Compared against our own copy, every document differs that either side changed, so
        // an overlap is exactly a document that differs AND that we touched.
        const changes = diffDocuments(this._documents, next);
        const affected = new Set<string>([
            ...[...changes.assetOps.keys()].map((id) => `assets/${id}`),
            ...changes.addedAssets.map((id) => `assets/${id}`),
            ...changes.removedAssets.map((id) => `assets/${id}`),
            ...[...changes.sceneOps.keys()].map((id) => `scenes/${id}`),
            ...changes.structuralSceneIds.map((id) => `scenes/${id}`)
        ]);

        // A document we touched differs because of our own unwritten edit, so it is only an
        // overlap if their copy also moved away from the base we last wrote. Compare their
        // version against the last one we know landed.
        const base: Documents = this._writtenDocuments || {};
        for (const key of affected) {
            if (!this._touched.has(key)) continue;
            const [collection, id] = key.split('/');
            const theirs = next[collection]?.[id];
            const wrote = base[collection]?.[id];
            if (JSON.stringify(theirs) !== JSON.stringify(wrote)) {
                return false; // both sides changed the same document
            }
        }

        // Nothing they changed is anything we changed, so both versions can stand.

        // Their change stands on top of ours, then our write goes out against their revision.
        for (const [collection, documents] of Object.entries(next)) {
            for (const [id, data] of Object.entries(documents)) {
                if (this._touched.has(`${collection}/${id}`)) continue;
                this._documents[collection] ??= {};
                this._documents[collection][id] = data;
            }
        }
        this._revision = stored.revision ?? this._revision;
        this._externalApply?.(changes, this._documents);
        return true;
    }

    /**
     * Subscribe to folder changes so hand-edits to the manifest reach the editor instead of
     * being overwritten by its next save. Called once the editor is ready to receive
     * operations; the caller supplies how to apply them (see `src/editor/local/sync.ts`).
     */
    watchFolder(
        apply: (changes: ReturnType<typeof diffDocuments>, documents: Documents) => void,
        onFilesChanged?: (assetIds: number[]) => void
    ) {
        if (this._eventStream || typeof EventSource === 'undefined') return;

        this._externalApply = apply;
        this._eventStream = new EventSource(this._folderUrl('/events'));
        this._eventStream.addEventListener('message', (event: MessageEvent) => {
            let payload: { type?: string; revision?: string; paths?: string[] };
            try {
                payload = JSON.parse(event.data);
            } catch {
                return;
            }

            if (payload.type === 'assets') {
                const ids = this._bumpFileVersions(payload.paths || []);
                if (ids.length) onFilesChanged?.(ids);
                return;
            }

            if (payload.type !== 'manifest') return;
            this._onFolderChanged(apply).catch((error) => {
                console.warn('Could not apply the project folder change.', error);
            });
        });
        this._eventStream.addEventListener('error', () => {
            // EventSource reconnects on its own; nothing to do but avoid noisy logging.
        });
    }

    unwatchFolder() {
        this._eventStream?.close();
        this._eventStream = null;
    }

    /** Read the manifest afresh and hand the difference to the editor. */
    private async _onFolderChanged(apply: (changes: ReturnType<typeof diffDocuments>, documents: Documents) => void) {
        // Anything we have queued would be written from a stale base, so let it settle first.
        await this.flush();

        const response = await fetch(this._folderUrl('/manifest'));
        if (!response.ok) return;
        const stored = await response.json();
        const next: Documents = stored.documents || stored;

        const changes = diffDocuments(this._documents, next);
        const previous = this._documents;
        this._documents = next;
        this._revision = stored.revision ?? this._revision;

        // Asset payload locations may have moved, so rebuild the url map before the editor
        // reads any of them back.
        if (changes.assetOps.size || changes.addedAssets.length || changes.removedAssets.length) {
            this._fileUrls.clear();
            await this._readFolderAssetFiles();
        }

        const empty =
            !changes.assetOps.size &&
            !changes.sceneOps.size &&
            !changes.addedAssets.length &&
            !changes.removedAssets.length &&
            !changes.structuralSceneIds.length;
        if (empty) return;

        void previous;
        apply(changes, next);
        this.emit('folder:changed', changes);
    }

    getDocument(collection: string, id: string | number) {
        return this._documents[collection]?.[id.toString()] ?? null;
    }

    setDocument(collection: string, id: string | number, data: Record<string, any>) {
        this._documents[collection] ??= {};
        const document = clone(data);
        if (collection === 'assets') {
            const existing = this._documents.assets?.[id.toString()];
            document.item_id = Number(id);
            document.branch_id = 'local';
            document.createdAt ||= existing?.createdAt || new Date().toISOString();
            delete document.id;
            delete document.uniqueId;
            if (document.file) delete document.file.url;
        }
        this._documents[collection][id.toString()] = document;
        this._touched.add(`${collection}/${id}`);
        this._persist();
        this.emit('document:set', collection, id.toString(), clone(document));
    }

    listAssets() {
        return Object.values(this._documents.assets || {}).map((asset) => clone(asset));
    }

    listScenes() {
        return Object.values(this._documents.scenes || {}).map((scene) => ({
            id: Number(scene.item_id),
            uniqueId: Number(scene.item_id),
            name: scene.name || `Scene ${scene.item_id}`,
            modified: scene.modified || new Date(0).toISOString()
        }));
    }

    getScene(id: string | number) {
        const scene = this.getDocument('scenes', id);
        if (!scene) return null;
        return {
            id: Number(scene.item_id),
            uniqueId: Number(scene.item_id),
            name: scene.name || `Scene ${scene.item_id}`,
            modified: scene.modified || new Date(0).toISOString()
        };
    }

    createScene(name: string, duplicateFrom?: string | number) {
        const ids = Object.keys(this._documents.scenes || {}).map(Number);
        const id = Math.max(0, ...ids) + 1;
        const source = this.getDocument('scenes', duplicateFrom || 1) || Object.values(this._documents.scenes || {})[0];
        if (!source) throw new Error('No local scene template is available');
        const scene = clone(source);
        scene.item_id = id;
        scene.name = name || `Scene ${id}`;
        scene.modified = new Date().toISOString();
        this.setDocument('scenes', id, scene);
        return this.getScene(id);
    }

    deleteScene(id: string | number) {
        delete this._documents.scenes?.[id.toString()];
        this._persist();
    }

    getFileUrl(id: number) {
        return this._fileUrls.get(id) || '';
    }

    async saveAsset(data: Record<string, any>, blob?: Blob) {
        await this.initialize();

        const existingId = data.id ? Number(data.id) : null;
        const ids = Object.keys(this._documents.assets || {}).map(Number);
        const id = existingId || Math.max(0, ...ids) + 1;
        const current = this.getDocument('assets', id) || {};
        const filename = data.filename || data.name || current.file?.filename;
        const localPath =
            current.file?.localPath || this._newLocalPath(id, filename, data.folderId, current);
        const file = blob
            ? {
                  filename,
                  size: blob.size,
                  hash: '',
                  variants: null,
                  localPath
              }
            : current.file || null;

        const asset = {
            item_id: id,
            branch_id: 'local',
            name: data.name || current.name || 'New Asset',
            type: data.type || current.type || 'binary',
            source: data.source ?? current.source ?? false,
            source_asset_id: data.sourceAssetId ?? current.source_asset_id ?? null,
            tags: data.tags || current.tags || [],
            path: data.folderId
                ? [...(this.getDocument('assets', data.folderId)?.path || []), data.folderId]
                : current.path || [],
            scope: current.scope || { type: 'project', id: 1 },
            data: data.data ?? current.data ?? null,
            meta: data.meta ?? current.meta ?? null,
            preload: data.preload ?? current.preload ?? true,
            file,
            has_thumbnail: false,
            createdAt: current.createdAt || new Date().toISOString()
        };

        if (blob) {
            const url = this._assetFileUrl(localPath);
            const response = await fetch(url, { method: 'PUT', body: blob });
            if (!response.ok) throw new Error(`Could not save the local asset (${response.status}).`);
            this._fileUrls.set(id, url);
        }

        this.setDocument('assets', id, asset);
        await this.flush();

        return clone(asset);
    }

    async deleteAssets(ids: number[]) {
        await this.initialize();
        const localPaths = ids
            .map((id) => this._documents.assets?.[id.toString()]?.file?.localPath)
            .filter((path): path is string => Boolean(path));
        for (const id of ids) {
            delete this._documents.assets?.[id.toString()];
            this._fileUrls.delete(id);
        }
        this._persist();

        for (const path of localPaths) {
            const response = await fetch(this._assetFileUrl(path), { method: 'DELETE' });
            if (!response.ok) throw new Error(`Could not delete the local asset (${response.status}).`);
        }
        await this.flush();
    }

    /**
     * Delete assets along with everything inside any folder among them. Returns every id
     * actually removed so the caller can drop the matching assets from the editor.
     */
    async deleteAssetsRecursive(ids: number[]) {
        await this.initialize();
        const removed = this._withDescendants(ids);
        await this.deleteAssets(removed);
        return { removed };
    }

    /**
     * Reparent assets under `folderId` (null for the project root), carrying the contents of
     * any moved folder with them. Returns the new `path` per moved asset so the caller can
     * update the observers, which is what refreshes the UI and persists the change.
     */
    async moveAssets(ids: number[], folderId: number | null) {
        await this.initialize();
        const assets = this._documents.assets || {};

        const targetPath = folderId ? [...(assets[String(folderId)]?.path || []), folderId] : [];
        if (folderId && !assets[String(folderId)]) {
            return { error: 'The destination folder no longer exists.' };
        }

        // A folder cannot be moved inside itself or its own contents.
        for (const id of ids) {
            if (folderId === id || targetPath.includes(id)) {
                return { error: 'A folder cannot be moved into itself.' };
            }
        }

        // Dropping a folder and something inside it together: the folder move already
        // carries the contents, so only the outermost selections are moved directly.
        const roots = ids.filter((id) => {
            const path: number[] = assets[String(id)]?.path || [];
            return !ids.some((other) => other !== id && path.includes(other));
        });

        const changed = new Set<number>();
        for (const id of roots) {
            const asset = assets[String(id)];
            if (!asset) continue;
            const oldPath: number[] = asset.path || [];
            asset.path = [...targetPath];
            changed.add(id);

            // Descendants keep their depth relative to the asset that moved.
            if (asset.type === 'folder') {
                for (const descendantId of this._withDescendants([id])) {
                    if (descendantId === id) continue;
                    const descendant = assets[String(descendantId)];
                    if (!descendant) continue;
                    const relative = (descendant.path || []).slice(oldPath.length);
                    descendant.path = [...targetPath, ...relative];
                    changed.add(descendantId);
                }
            }
        }

        this._persist();
        await this._syncAssetFileLayout([...changed]);
        await this.flush();
        return { updates: this._updatesFor([...changed]) };
    }

    /** Rename an asset, moving its payload (and any folder contents) to match. */
    async renameAsset(id: number, name: string) {
        await this.initialize();
        const asset = this._documents.assets?.[String(id)];
        if (!asset) return { error: `Could not rename local asset ${id}.` };

        asset.name = name;
        this._persist();

        const affected = this._withDescendants([id]);
        await this._syncAssetFileLayout(affected);
        await this.flush();
        return { updates: this._updatesFor(affected) };
    }

    /**
     * The fields an observer must be re-synced with after a layout change. `file` is in the
     * editor's sync list, so an observer holding a stale `localPath` would write it back over
     * the manifest on its next op.
     */
    private _updatesFor(ids: number[]) {
        const updates = new Map<number, { path: number[]; localPath: string | null }>();
        for (const id of ids) {
            const asset = this._documents.assets?.[String(id)];
            if (!asset) continue;
            updates.set(id, { path: asset.path || [], localPath: asset.file?.localPath ?? null });
        }
        return updates;
    }

    /** Initial on-disk location for a newly created asset. */
    private _newLocalPath(
        id: number,
        filename: string | undefined,
        folderId: number | undefined,
        current: Record<string, any>
    ) {
        const leaf = safeFilename(filename || `asset-${id}`);
        const path = folderId
            ? [...(this.getDocument('assets', folderId)?.path || []), folderId]
            : current.path || [];
        const probe = { name: filename, path, file: { localPath: leaf, filename } } as Record<string, any>;
        return this._desiredLocalPath(id, probe) || leaf;
    }
}

export { type LocalProjectOptions, LocalProjectStore };
