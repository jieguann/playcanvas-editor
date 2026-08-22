import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
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

const assetPath = (project, filename) => {
    if (!filename || basename(filename) !== filename || filename === '.' || filename === '..') return null;
    const assetsDirectory = resolve(project.path, 'assets');
    const target = resolve(assetsDirectory, filename);
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
    if (segments[3] === 'manifest' && segments.length === 4) {
        if (request.method === 'GET') {
            try {
                sendJson(response, 200, JSON.parse(await readFile(manifestFilename, 'utf8')));
            } catch (error) {
                if (error.code === 'ENOENT') sendJson(response, 404, { error: 'Project has not been created yet.' });
                else throw error;
            }
            return true;
        }
        if (request.method === 'PUT') {
            const data = await readJsonBody(request);
            await writeFile(manifestFilename, JSON.stringify(data, null, 2), 'utf8');
            sendJson(response, 200, { saved: true });
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
            await mkdir(location.assetsDirectory, { recursive: true });
            await pipeline(request, createWriteStream(location.target));
            sendJson(response, 200, { saved: true });
            return true;
        }
        if (request.method === 'DELETE') {
            try {
                await unlink(location.target);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
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
