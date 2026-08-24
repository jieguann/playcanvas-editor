import { expect } from 'chai';
import { beforeEach, describe, it } from 'mocha';

import { LocalProjectStore } from '../../src/editor-api/local/project-store';

/**
 * Models the local server's revision handling: the manifest carries a revision, and a PUT
 * whose `baseRevision` no longer matches is refused with 409 instead of overwriting.
 */
const install = () => {
    let disk: any = {
        format: 'playcanvas-local-project',
        version: 1,
        name: 'test',
        documents: { assets: { 1: { item_id: 1, name: 'a.js', path: [] } }, scenes: {}, settings: {} }
    };
    let revision = 'r1';
    let counter = 1;
    const puts: any[] = [];
    let refused = 0;

    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const ok = (body: any = {}) => ({ ok: true, status: 200, json: async () => body });

        if (url.endsWith('/manifest')) {
            if (method === 'PUT') {
                const body = JSON.parse(init.body);
                puts.push(body);
                if (body.baseRevision !== undefined && body.baseRevision !== revision) {
                    refused++;
                    return { ok: false, status: 409, json: async () => ({ error: 'conflict', revision }) };
                }
                disk = { ...body };
                delete disk.baseRevision;
                revision = `r${++counter}`;
                return ok({ saved: true, revision });
            }
            return ok({ ...disk, revision });
        }
        return ok();
    }) as any;

    const store = new LocalProjectStore({
        enabled: true,
        projectName: 'test',
        directoryId: 'test',
        documents: {}
    } as any);

    return {
        store,
        puts,
        get refused() {
            return refused;
        },
        get disk() {
            return disk;
        },
        /** Simulate someone else writing the folder, invalidating the store's revision. */
        externalWrite(mutate: (documents: any) => void) {
            mutate(disk.documents);
            revision = `external-${++counter}`;
        }
    };
};

describe('LocalProjectStore conflicts', () => {
    let ctx: ReturnType<typeof install>;

    beforeEach(() => {
        ctx = install();
    });

    it('sends the base revision so the server can refuse a stale write', async () => {
        await ctx.store.initialize();
        ctx.store.setDocument('assets', 1, { name: 'renamed.js', path: [] });
        await ctx.store.flush();

        expect(ctx.puts.at(-1).baseRevision).to.be.a('string');
        expect(ctx.refused).to.equal(0);
        expect(ctx.disk.documents.assets['1'].name).to.equal('renamed.js');
    });

    it('reports a conflict instead of overwriting an outside change', async () => {
        await ctx.store.initialize();

        const conflicts: any[] = [];
        ctx.store.on('conflict', (resolution: any) => conflicts.push(resolution));

        ctx.externalWrite((documents) => {
            documents.assets['1'].name = 'from-disk.js';
        });

        ctx.store.setDocument('assets', 1, { name: 'from-editor.js', path: [] });
        await ctx.store.flush();

        expect(ctx.refused).to.equal(1);
        expect(conflicts.length).to.equal(1);
        // the outside change must still be on disk
        expect(ctx.disk.documents.assets['1'].name).to.equal('from-disk.js');
    });

    it('writes nothing more until the conflict is resolved', async () => {
        // This is the guard that protects the folder: queued writes were built from a base
        // the folder has already moved past, so letting them run would destroy the change
        // the user is being asked about.
        await ctx.store.initialize();
        ctx.store.on('conflict', () => {});

        ctx.externalWrite((documents) => {
            documents.assets['1'].name = 'from-disk.js';
        });

        ctx.store.setDocument('assets', 1, { name: 'first.js', path: [] });
        await ctx.store.flush();
        const afterConflict = ctx.puts.length;

        // more editor activity while the prompt is up
        ctx.store.setDocument('assets', 1, { name: 'second.js', path: [] });
        ctx.store.setDocument('assets', 1, { name: 'third.js', path: [] });
        await ctx.store.flush();

        expect(ctx.puts.length, 'no further writes while conflicted').to.equal(afterConflict);
        expect(ctx.disk.documents.assets['1'].name).to.equal('from-disk.js');
    });

    it('overwrites the folder when the editor version is kept', async () => {
        await ctx.store.initialize();
        let resolution: any = null;
        ctx.store.on('conflict', (value: any) => {
            resolution = value;
        });

        ctx.externalWrite((documents) => {
            documents.assets['1'].name = 'from-disk.js';
        });
        ctx.store.setDocument('assets', 1, { name: 'from-editor.js', path: [] });
        await ctx.store.flush();

        expect(resolution).to.not.equal(null);
        await resolution.keepEditor();
        await ctx.store.flush();

        expect(ctx.disk.documents.assets['1'].name).to.equal('from-editor.js');
    });

    it('merges an outside change that does not overlap, without prompting', async () => {
        // Two tabs on one folder interleave constantly: the second to save is always working
        // from a stale revision, even when the two edited different assets.
        await ctx.store.initialize();
        ctx.disk.documents.assets['2'] = { item_id: 2, name: 'theirs.js', path: [] };
        const conflicts: any[] = [];
        ctx.store.on('conflict', (value: any) => conflicts.push(value));

        ctx.externalWrite((documents) => {
            documents.assets['2'].name = 'they-renamed.js';
        });

        // this client only ever touched asset 1
        ctx.store.setDocument('assets', 1, { name: 'mine.js', path: [] });
        await ctx.store.flush();

        expect(conflicts.length, 'a non-overlapping change should not prompt').to.equal(0);
        expect(ctx.disk.documents.assets['1'].name).to.equal('mine.js');
        expect(ctx.disk.documents.assets['2'].name, 'their change survives').to.equal('they-renamed.js');
    });

    it('still prompts when both sides changed the same document', async () => {
        await ctx.store.initialize();
        const conflicts: any[] = [];
        ctx.store.on('conflict', (value: any) => conflicts.push(value));

        ctx.externalWrite((documents) => {
            documents.assets['1'].name = 'theirs.js';
        });
        ctx.store.setDocument('assets', 1, { name: 'mine.js', path: [] });
        await ctx.store.flush();

        expect(conflicts.length, 'an overlap must be surfaced').to.equal(1);
        expect(ctx.disk.documents.assets['1'].name).to.equal('theirs.js');
    });

    it('resumes normal saving after a conflict is dismissed', async () => {
        await ctx.store.initialize();
        let resolution: any = null;
        ctx.store.on('conflict', (value: any) => {
            resolution = value;
        });

        ctx.externalWrite((documents) => {
            documents.assets['1'].name = 'from-disk.js';
        });
        ctx.store.setDocument('assets', 1, { name: 'blocked.js', path: [] });
        await ctx.store.flush();

        resolution.dismiss();
        // A dismissed conflict leaves the folder alone; the next write picks up the revision
        // the store learns from its next read, so saving is not wedged forever.
        expect(ctx.disk.documents.assets['1'].name).to.equal('from-disk.js');
    });
});
