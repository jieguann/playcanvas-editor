import { Events } from '@playcanvas/observer';

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
    projectKey: string;
    projectName: string;
    storage: 'browser' | 'folder';
    directoryId?: string;
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
 * Storage for the standalone editor. Folder projects use a JSON manifest and
 * asset files in the selected directory; legacy projects retain browser storage.
 */
class LocalProjectStore extends Events {
    private _key: string;

    private _defaults: Documents;

    private _projectName: string;

    private _storage: 'browser' | 'folder';

    private _directoryId?: string;

    private _documents: Documents = {};

    private _database: IDBDatabase | null = null;

    private _fileUrls = new Map<number, string>();

    private _ready: Promise<void> | null = null;

    private _writeQueue = Promise.resolve();

    constructor(options: LocalProjectOptions) {
        super();
        this._key = `playcanvas-local:${options.projectKey}`;
        this._projectName = options.projectName;
        this._storage = options.storage;
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
        if (this._storage === 'folder') {
            await this._initializeFolder();
        } else {
            const saved = localStorage.getItem(`${this._key}:documents`);
            this._documents = saved ? JSON.parse(saved) : clone(this._defaults);
        }

        // New document types added by later editor versions should be available
        // without overwriting anything the user has already saved.
        for (const [collection, documents] of Object.entries(this._defaults)) {
            this._documents[collection] ??= {};
            for (const [id, data] of Object.entries(documents)) {
                this._documents[collection][id] ??= clone(data);
            }
        }

        this._migrateStarterLights();

        if (this._storage === 'folder') {
            await this._readFolderAssetFiles();
            await this._writeFolderDocuments(this._documents);
        } else {
            this._database = await this._openDatabase();
            const files = await this._readAllFiles();
            for (const { id, blob } of files) {
                this._setFileUrl(id, blob);
            }
            this._persist();
        }
    }

    private async _initializeFolder() {
        if (!this._directoryId) throw new Error('No project folder was selected.');
        const response = await fetch(this._folderUrl('/manifest'));
        if (response.status === 404) {
            this._documents = clone(this._defaults);
            return;
        }
        if (!response.ok) throw new Error(`Could not open the project folder (${response.status}).`);
        const storedProject = await response.json();
        this._documents = storedProject.documents || storedProject;
    }

    private async _readFolderAssetFiles() {
        for (const asset of Object.values(this._documents.assets || {})) {
            const id = Number(asset.item_id);
            const localPath = asset.file?.localPath;
            if (!id || !localPath) continue;
            this._fileUrls.set(id, this._folderUrl(`/assets/${encodeURIComponent(localPath)}`));
        }
    }

    private _folderUrl(path: string) {
        if (!this._directoryId) throw new Error('No project folder was selected.');
        return `/local-api/projects/${encodeURIComponent(this._directoryId)}${path}`;
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

    private _openDatabase() {
        return new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(`${this._key}:files`, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('files', { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    private _readAllFiles() {
        if (!this._database) return Promise.resolve([] as { id: number; blob: Blob }[]);
        return new Promise<{ id: number; blob: Blob }[]>((resolve, reject) => {
            const request = this._database.transaction('files').objectStore('files').getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    private _persist() {
        if (this._storage === 'folder') {
            const snapshot = clone(this._documents);
            this._writeQueue = this._writeQueue
                .then(() => this._writeFolderDocuments(snapshot))
                .catch((error) => console.error('Could not save the local folder project.', error));
        } else {
            localStorage.setItem(`${this._key}:documents`, JSON.stringify(this._documents));
        }
    }

    private async _writeFolderDocuments(documents: Documents) {
        const response = await fetch(this._folderUrl('/manifest'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                format: 'playcanvas-local-project',
                version: 1,
                name: this._projectName,
                documents
            })
        });
        if (!response.ok) throw new Error(`Could not save the project folder (${response.status}).`);
    }

    private _setFileUrl(id: number, blob: Blob) {
        const previous = this._fileUrls.get(id);
        if (previous) URL.revokeObjectURL(previous);
        this._fileUrls.set(id, URL.createObjectURL(blob));
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
            current.file?.localPath ||
            (this._storage === 'folder' ? `${id}-${safeFilename(filename || `asset-${id}`)}` : undefined);
        const file = blob
            ? {
                  filename,
                  size: blob.size,
                  hash: '',
                  variants: null,
                  ...(localPath ? { localPath } : {})
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

        if (blob && this._storage === 'folder' && localPath) {
            const url = this._folderUrl(`/assets/${encodeURIComponent(localPath)}`);
            const response = await fetch(url, { method: 'PUT', body: blob });
            if (!response.ok) throw new Error(`Could not save the local asset (${response.status}).`);
            this._fileUrls.set(id, url);
        } else if (blob && this._database) {
            await new Promise<void>((resolve, reject) => {
                const request = this._database!.transaction('files', 'readwrite')
                    .objectStore('files')
                    .put({ id, blob });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
            this._setFileUrl(id, blob);
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
            const url = this._fileUrls.get(id);
            if (url) URL.revokeObjectURL(url);
            this._fileUrls.delete(id);
        }
        this._persist();

        if (this._storage === 'folder') {
            for (const path of localPaths) {
                const response = await fetch(this._folderUrl(`/assets/${encodeURIComponent(path)}`), {
                    method: 'DELETE'
                });
                if (!response.ok) throw new Error(`Could not delete the local asset (${response.status}).`);
            }
        } else if (this._database) {
            await new Promise<void>((resolve, reject) => {
                const transaction = this._database.transaction('files', 'readwrite');
                for (const id of ids) transaction.objectStore('files').delete(id);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        }
        await this.flush();
    }
}

export { type LocalProjectOptions, LocalProjectStore };
