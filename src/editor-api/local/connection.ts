import { Events } from '@playcanvas/observer';

import type { Realtime } from '../realtime';
import { RealtimeConnection } from '../realtime/connection';

import type { LocalProjectStore } from './project-store';

type JsonOp = {
    p: (string | number)[];
    oi?: any;
    od?: any;
    li?: any;
    ld?: any;
    lm?: number;
    na?: number;
    si?: string;
    sd?: string;
};

const parentAt = (root: any, path: (string | number)[]) => {
    let value = root;
    for (let i = 0; i < path.length - 1; i++) value = value[path[i]];
    return { value, key: path[path.length - 1] };
};

const applyOperation = (root: any, op: JsonOp) => {
    if (!op.p.length && op.oi !== undefined) return op.oi;

    if (op.si !== undefined || op.sd !== undefined) {
        const stringIndex = Number(op.p[op.p.length - 1]);
        const { value, key } = parentAt(root, op.p.slice(0, -1));
        const current = `${value[key] || ''}`;
        value[key] =
            op.si !== undefined
                ? current.slice(0, stringIndex) + op.si + current.slice(stringIndex)
                : current.slice(0, stringIndex) + current.slice(stringIndex + op.sd!.length);
        return root;
    }

    const { value, key } = parentAt(root, op.p);

    if (op.na !== undefined) value[key] += op.na;
    else if (op.lm !== undefined) value.splice(op.lm, 0, value.splice(Number(key), 1)[0]);
    else if (op.li !== undefined && op.ld !== undefined) value.splice(Number(key), 1, op.li);
    else if (op.li !== undefined) value.splice(Number(key), 0, op.li);
    else if (op.ld !== undefined) value.splice(Number(key), 1);
    else if (op.oi !== undefined) value[key] = op.oi;
    else if (op.od !== undefined) delete value[key];
    return root;
};

class LocalDocument extends Events {
    data: any;

    type = 'json0';

    private _store: LocalProjectStore;

    private _collection: string;

    private _id: string;

    constructor(store: LocalProjectStore, collection: string, id: string) {
        super();
        this._store = store;
        this._collection = collection;
        this._id = id;
    }

    subscribe(callback?: (err?: unknown) => void) {
        queueMicrotask(() => {
            this.data = structuredClone(this._store.getDocument(this._collection, this._id));
            if (!this.data && this._collection === 'user_data') {
                this.data = { cameras: {} };
                this._store.setDocument(this._collection, this._id, structuredClone(this.data));
            }
            if (!this.data) {
                const error = new Error(`Local document not found: ${this._collection}/${this._id}`);
                callback?.(error);
                this.emit('error', error);
                return;
            }
            callback?.();
            this.emit('load');
        });
    }

    submitOp(operations: JsonOp[], callback?: (err?: unknown) => void) {
        try {
            for (const operation of operations) this.data = applyOperation(this.data, operation);
            this._store.setDocument(this._collection, this._id, this.data);
            this.emit('op', operations, true);
            callback?.();
        } catch (error) {
            callback?.(error);
            this.emit('error', error);
        }
    }

    /**
     * Apply an operation that came from outside the editor - a hand-edit to the project
     * folder - and emit it as remote.
     *
     * `submitOp` marks operations local, which is what stops the editor's own changes from
     * echoing back into it; the same flag would also suppress an external change, so these
     * are emitted with `local = false` to reach the inbound handlers. The store already
     * holds the new documents, so this deliberately does not write back.
     */
    applyRemoteOp(operations: JsonOp[]) {
        try {
            for (const operation of operations) this.data = applyOperation(this.data, operation);
            this.emit('op', operations, false);
        } catch (error) {
            this.emit('error', error);
        }
    }

    whenNothingPending(callback: (...args: any[]) => unknown) {
        queueMicrotask(callback);
    }

    destroy() {
        return undefined;
    }

    unsubscribe() {
        return undefined;
    }
}

/** ShareDB-compatible connection backed by LocalProjectStore. */
class LocalRealtimeConnection extends RealtimeConnection {
    private _store: LocalProjectStore;

    private _localRealtime: Realtime;

    private _localState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

    private _openDocuments = new Map<string, LocalDocument>();

    constructor(realtime: Realtime, store: LocalProjectStore) {
        super(realtime);
        this._localRealtime = realtime;
        this._store = store;
    }

    override async connect(_url: string) {
        if (this._localState !== 'disconnected') return;
        this._localState = 'connecting';
        this._localRealtime.emit('connecting', 1);
        await this._store.initialize();
        this._localState = 'connected';
        this.emit('connected');
        this._localRealtime.emit('connected');
        this._localRealtime.emit('authenticated');
    }

    override disconnect() {
        if (this._localState === 'disconnected') return;
        this._localState = 'disconnected';
        this._localRealtime.emit('disconnect', 'local connection closed');
    }

    override sendMessage(_name: string, _data: object) {
        return undefined;
    }

    override async send(_data: string) {
        return undefined;
    }

    override getDocument(collection: string, id: number) {
        return this.documentFor(collection, id.toString()) as any;
    }

    get(collection: string, id: string) {
        return this.documentFor(collection, id);
    }

    /**
     * The document for a collection entry, reused across calls.
     *
     * Callers used to get a fresh instance every time, so nothing could reach the live one
     * to deliver an external change - and two subscribers to the same document held
     * independent copies of its data.
     */
    documentFor(collection: string, id: string) {
        const key = `${collection}/${id}`;
        let document = this._openDocuments.get(key);
        if (!document) {
            document = new LocalDocument(this._store, collection, id);
            this._openDocuments.set(key, document);
        }
        return document;
    }

    override startBulkSubscribe() {
        return undefined;
    }

    override endBulkSubscribe() {
        return undefined;
    }

    startBulk() {
        return undefined;
    }

    endBulk() {
        return undefined;
    }

    override get connected() {
        return this._localState === 'connected';
    }

    override get authenticated() {
        return this.connected;
    }

    get state() {
        return this._localState;
    }

    override get sharedb() {
        return this as any;
    }
}

export { LocalDocument, LocalRealtimeConnection };
