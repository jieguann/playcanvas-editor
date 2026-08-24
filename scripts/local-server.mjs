import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync, watch } from 'node:fs';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve('dist');
const port = Number(process.env.PLAYCANVAS_LOCAL_PORT || 3487);
const registryDirectory = resolve(
    process.env.PLAYCANVAS_LOCAL_STATE_DIR || join(homedir(), '.playcanvas-local-editor')
);
const registryFilename = join(registryDirectory, 'projects.json');
const projectFilename = 'playcanvas-project.json';
const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

const sendJson = (response, status, data) => {
    response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify(data));
};

const readRegistry = async () => {
    try {
        const data = JSON.parse(await readFile(registryFilename, 'utf8'));
        return Array.isArray(data.projects) ? data.projects : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
};

const writeRegistry = async (projects) => {
    await mkdir(registryDirectory, { recursive: true });
    await writeFile(registryFilename, JSON.stringify({ version: 1, projects }, null, 2), 'utf8');
};

const projectIdForPath = (directory) => {
    const normalized = process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
};

const getProject = async (id) => (await readRegistry()).find((project) => project.id === id);

// Drop the local-project authoring guide into new project folders so it travels with
// the folder when it is copied or shared, rather than only existing on this machine.
const skillFilename = 'SKILL.md';
const skillSource = resolve('.claude/skills/playcanvas-local-project', skillFilename);
const skillTargetDirectory = join('.claude', 'skills', 'playcanvas-local-project');

const writeProjectSkill = async (directory) => {
    const target = join(directory, skillTargetDirectory, skillFilename);
    // never clobber a copy the user has edited
    if (existsSync(target)) return;
    try {
        const contents = await readFile(skillSource, 'utf8');
        await mkdir(join(directory, skillTargetDirectory), { recursive: true });
        await writeFile(target, contents, 'utf8');
    } catch (error) {
        // scaffolding is a convenience; never fail opening a project over it
        console.warn(`Could not write the project authoring guide: ${error.message}`);
    }
};

const getStartSceneId = async (project) => {
    try {
        const stored = JSON.parse(await readFile(join(project.path, projectFilename), 'utf8'));
        const scenes = stored.documents?.scenes || stored.scenes || {};
        const ids = Object.keys(scenes).map(Number).filter(Number.isFinite);
        return ids.length ? Math.min(...ids) : 1;
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return 1;
        throw error;
    }
};

const projectInfo = async (project) => ({
    ...project,
    startSceneId: await getStartSceneId(project)
});

const chooseDirectory = async () => {
    if (process.platform === 'win32') {
        const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$owner = New-Object System.Windows.Forms.Form',
            '$owner.TopMost = $true',
            '$owner.ShowInTaskbar = $false',
            '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
            '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
            "$dialog.Description = 'Choose a PlayCanvas project folder'",
            '$dialog.ShowNewFolderButton = $true',
            '$result = $dialog.ShowDialog($owner)',
            '$owner.Dispose()',
            'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
            '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            '  Write-Output $dialog.SelectedPath',
            '}'
        ].join('; ');
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 1024 * 1024
        });
        return stdout.trim();
    }

    if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('osascript', [
            '-e',
            'POSIX path of (choose folder with prompt "Choose a PlayCanvas project folder")'
        ]);
        return stdout.trim();
    }

    const { stdout } = await execFileAsync('zenity', [
        '--file-selection',
        '--directory',
        '--title=Choose a PlayCanvas project folder'
    ]);
    return stdout.trim();
};

const readJsonBody = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 200 * 1024 * 1024) throw new Error('Project data is too large to save.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

// Live sync: watch a project folder and push changes to any subscribed browser tab.
//
// The editor holds the whole project in memory, so a hand-edit on disk has to be pushed to
// it or the next editor write would silently overwrite it. Server-Sent Events carry the
// notification: same-origin, so the local pages' CSP allows it with no change, and no extra
// dependency (a WebSocket would need both).
const WATCH_DEBOUNCE = 150;
const HEARTBEAT_INTERVAL = 25000;

/** How many of our own recent writes to remember when recognising echoes. */
const OWN_WRITE_MEMORY = 8;

/** projectId -> { clients, watcher, timer, lastHash, ownHashes, heartbeat } */
const subscriptions = new Map();

const hashOf = (contents) => createHash('sha256').update(contents).digest('hex');

const readManifestHash = async (project) => {
    try {
        return hashOf(await readFile(join(project.path, projectFilename), 'utf8'));
    } catch {
        return null;
    }
};

/**
 * Record the bytes we just wrote so the watcher can recognise the editor's own save and not
 * echo it back. Hashing the content is exact, unlike an mtime or a time window.
 */
const rememberWrite = (projectId, contents) => {
    const subscription = subscriptions.get(projectId);
    if (!subscription) return;
    const hash = hashOf(contents);
    subscription.lastHash = hash;
    // Saves can queue up, and a filesystem event for an earlier one can arrive after a later
    // one has already landed. Remembering only the newest hash would let those look external.
    subscription.ownHashes.add(hash);
    while (subscription.ownHashes.size > OWN_WRITE_MEMORY) {
        subscription.ownHashes.delete(subscription.ownHashes.values().next().value);
    }
};

/**
 * Note an asset file we wrote, so the watcher does not report it as an external change.
 * A path is enough here: unlike the manifest, the worst case is a redundant notification.
 */
const rememberAssetWrite = (projectId, localPath) => {
    const subscription = subscriptions.get(projectId);
    if (!subscription) return;
    subscription.ownFiles.set(localPath.split(sep).join('/'), Date.now());
};

const notifySubscribers = (subscription, payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of subscription.clients) {
        try {
            client.write(frame);
        } catch {
            subscription.clients.delete(client);
        }
    }
};

const onFolderChange = async (projectId, project, changedPaths) => {
    const subscription = subscriptions.get(projectId);
    if (!subscription) return;

    // Asset payloads that changed on disk. The editor holds decoded resources (textures,
    // models) that would otherwise keep showing the old bytes.
    const assetPaths = [...changedPaths].filter((path) => path.startsWith(`assets${sep}`) || path.startsWith('assets/'));
    if (assetPaths.length) {
        const relative = assetPaths.map((path) => path.replace(/^assets[/\\]/, '').split(sep).join('/'));
        const external = relative.filter((path) => {
            const written = subscription.ownFiles.get(path);
            if (written === undefined) return true;
            subscription.ownFiles.delete(path);
            return false;
        });
        if (external.length) notifySubscribers(subscription, { type: 'assets', paths: external });
    }

    let contents;
    try {
        contents = await readFile(join(project.path, projectFilename), 'utf8');
    } catch {
        // the manifest may be mid-write or briefly absent; the next event will catch up
        return;
    }

    try {
        JSON.parse(contents);
    } catch {
        // a truncated read during someone else's write is normal, so wait for the next event
        return;
    }

    const hash = hashOf(contents);
    if (hash === subscription.lastHash || subscription.ownHashes.has(hash)) {
        // One of our own writes echoing back through the watcher.
        return;
    }

    subscription.lastHash = hash;
    notifySubscribers(subscription, { type: 'manifest', revision: hash });
};

const stopWatching = (projectId) => {
    const subscription = subscriptions.get(projectId);
    if (!subscription) return;
    clearTimeout(subscription.timer);
    clearInterval(subscription.heartbeat);
    try {
        subscription.watcher?.close();
    } catch {
        // already closed
    }
    subscriptions.delete(projectId);
};

const startWatching = async (projectId, project) => {
    const subscription = {
        clients: new Set(),
        watcher: null,
        timer: null,
        heartbeat: null,
        lastHash: await readManifestHash(project),
        ownHashes: new Set(),
        // Asset files we wrote ourselves, so their events are not reported as external.
        ownFiles: new Map(),
        pending: new Set()
    };
    subscriptions.set(projectId, subscription);

    try {
        // Coalesce bursts: editors write-then-rename, and FSEvents reports generously.
        subscription.watcher = watch(project.path, { recursive: true }, (_event, filename) => {
            if (filename) subscription.pending.add(filename);
            clearTimeout(subscription.timer);
            subscription.timer = setTimeout(() => {
                const changed = new Set(subscription.pending);
                subscription.pending.clear();
                onFolderChange(projectId, project, changed).catch((error) => {
                    console.warn(`Could not read the project folder change: ${error.message}`);
                });
            }, WATCH_DEBOUNCE);
        });
        subscription.watcher.on('error', (error) => {
            console.warn(`Stopped watching the project folder: ${error.message}`);
            stopWatching(projectId);
        });
    } catch (error) {
        console.warn(`Could not watch the project folder: ${error.message}`);
    }

    subscription.heartbeat = setInterval(() => {
        for (const client of subscription.clients) {
            try {
                client.write(': ping\n\n');
            } catch {
                subscription.clients.delete(client);
            }
        }
    }, HEARTBEAT_INTERVAL);

    return subscription;
};

// Remove directories left empty after a delete, stopping at (and never removing) assets/.
const pruneEmptyDirectories = async (directory, stopAt) => {
    let current = directory;
    while (current.startsWith(`${stopAt}${sep}`)) {
        try {
            await rmdir(current);
        } catch {
            // not empty, already gone, or racing another write - either way stop climbing
            return;
        }
        current = dirname(current);
    }
};

// Asset payloads mirror the editor's folder tree, so a relative subdirectory is allowed
// here. Absolute paths and any '..' traversal are not; the resolved-prefix check below is
// the backstop.
const assetPath = (project, filename) => {
    if (!filename) return null;
    const segments = filename.split(/[/\\]+/).filter(Boolean);
    if (!segments.length) return null;
    if (segments.some((segment) => segment === '.' || segment === '..')) return null;
    const assetsDirectory = resolve(project.path, 'assets');
    const target = resolve(assetsDirectory, ...segments);
    return target.startsWith(`${assetsDirectory}${sep}`) ? { assetsDirectory, target } : null;
};

const handleProjectApi = async (request, response, url) => {
    const segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));

    if (request.method === 'GET' && segments.length === 2) {
        const projects = await readRegistry();
        const details = await Promise.all(projects.sort((a, b) => b.lastOpened - a.lastOpened).map(projectInfo));
        sendJson(response, 200, details);
        return true;
    }

    if (request.method === 'POST' && segments[2] === 'select' && segments.length === 3) {
        const selected = await chooseDirectory();
        if (!selected) {
            response.writeHead(204).end();
            return true;
        }

        const directory = resolve(selected);
        const id = projectIdForPath(directory);
        const projects = await readRegistry();
        const existing = projects.find((project) => project.id === id);
        const project = {
            id,
            name: basename(directory) || directory,
            path: directory,
            ...existing,
            lastOpened: Date.now()
        };
        await mkdir(directory, { recursive: true });
        await writeProjectSkill(directory);
        await writeRegistry([project, ...projects.filter((item) => item.id !== id)]);
        sendJson(response, 200, await projectInfo(project));
        return true;
    }

    const id = segments[2];
    if (!id) return false;
    const project = await getProject(id);
    if (!project) {
        sendJson(response, 404, { error: 'Project folder is not registered.' });
        return true;
    }

    if (request.method === 'GET' && segments.length === 3) {
        sendJson(response, 200, await projectInfo(project));
        return true;
    }

    if (request.method === 'POST' && segments[3] === 'touch' && segments.length === 4) {
        const projects = await readRegistry();
        const updated = { ...project, lastOpened: Date.now() };
        await writeRegistry([updated, ...projects.filter((item) => item.id !== id)]);
        sendJson(response, 200, await projectInfo(updated));
        return true;
    }

    const manifestFilename = join(project.path, projectFilename);
    // Live-change stream: one watcher per project, started with the first subscriber and
    // closed with the last, so nothing is watched while no tab is open.
    if (request.method === 'GET' && segments[3] === 'events' && segments.length === 4) {
        response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        response.flushHeaders?.();

        const subscription = subscriptions.get(id) || (await startWatching(id, project));
        subscription.clients.add(response);
        response.write(`data: ${JSON.stringify({ type: 'ready', revision: subscription.lastHash })}\n\n`);

        request.on('close', () => {
            subscription.clients.delete(response);
            if (!subscription.clients.size) stopWatching(id);
        });
        return true;
    }

    if (segments[3] === 'manifest' && segments.length === 4) {
        if (request.method === 'GET') {
            try {
                const contents = await readFile(manifestFilename, 'utf8');
                // The revision lets the client detect that the file moved on underneath it.
                sendJson(response, 200, { ...JSON.parse(contents), revision: hashOf(contents) });
            } catch (error) {
                if (error.code === 'ENOENT') sendJson(response, 404, { error: 'Project has not been created yet.' });
                else throw error;
            }
            return true;
        }
        if (request.method === 'PUT') {
            const body = await readJsonBody(request);
            const { baseRevision, ...data } = body;

            // A base revision that no longer matches disk means someone else wrote in the
            // meantime; report the conflict instead of silently discarding their work.
            if (baseRevision !== undefined) {
                const current = await readManifestHash(project);
                if (current && current !== baseRevision) {
                    sendJson(response, 409, {
                        error: 'The project folder changed since this version was loaded.',
                        revision: current
                    });
                    return true;
                }
            }

            const contents = JSON.stringify(data, null, 2);
            rememberWrite(id, contents);
            await writeFile(manifestFilename, contents, 'utf8');
            sendJson(response, 200, { saved: true, revision: hashOf(contents) });
            return true;
        }
    }

    if (segments[3] === 'assets' && segments.length === 5) {
        const location = assetPath(project, segments[4]);
        if (!location) {
            sendJson(response, 400, { error: 'Invalid asset filename.' });
            return true;
        }
        if (request.method === 'GET') {
            if (!existsSync(location.target)) {
                sendJson(response, 404, { error: 'Asset file was not found.' });
                return true;
            }
            response.writeHead(200, {
                'Cache-Control': 'no-cache',
                'Content-Type': types[extname(location.target).toLowerCase()] || 'application/octet-stream'
            });
            createReadStream(location.target).pipe(response);
            return true;
        }
        if (request.method === 'PUT') {
            await mkdir(dirname(location.target), { recursive: true });
            await pipeline(request, createWriteStream(location.target));
            rememberAssetWrite(id, segments[4]);
            sendJson(response, 200, { saved: true });
            return true;
        }
        if (request.method === 'DELETE') {
            try {
                await unlink(location.target);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            rememberAssetWrite(id, segments[4]);
            await pruneEmptyDirectories(dirname(location.target), location.assetsDirectory);
            response.writeHead(204).end();
            return true;
        }
    }

    return false;
};

const serveStatic = (response, url) => {
    const pathname = decodeURIComponent(url.pathname);
    const relative = normalize(pathname).replace(/^([/\\])+/, '');
    let filename = resolve(join(root, relative));

    if (pathname === '/editor/scene/js/url-map.sw.js') {
        filename = join(root, 'js', 'url-map.sw.js');
    } else if (pathname.startsWith('/launch/')) {
        filename = join(root, 'launch', 'index.html');
    } else if (pathname.startsWith('/editor/scene/img/entity-icons/')) {
        filename = join(root, 'static', 'img', 'new_entity.gif');
    } else if (pathname.startsWith('/editor/scene/')) {
        filename = join(root, 'editor', 'index.html');
    }

    if (filename !== root && !filename.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }

    if (existsSync(filename) && statSync(filename).isDirectory()) filename = join(filename, 'index.html');
    if (!existsSync(filename)) filename = join(root, 'index.html');

    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Service-Worker-Allowed', '/');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', types[extname(filename)] || 'application/octet-stream');
    createReadStream(filename).pipe(response);
};

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname.startsWith('/local-api/projects')) {
            if (!(await handleProjectApi(request, response, url))) sendJson(response, 404, { error: 'Not found.' });
            return;
        }
        serveStatic(response, url);
    } catch (error) {
        console.error(error);
        if (!response.headersSent) sendJson(response, 500, { error: error.message || String(error) });
        else response.destroy(error);
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Local PlayCanvas Editor: http://127.0.0.1:${port}`);
    console.log('Press Ctrl+C to stop. Folder projects are saved directly on your computer.');
});
