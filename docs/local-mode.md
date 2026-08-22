# Standalone local mode

Standalone local mode runs the core Editor and Launch preview entirely from this repository. It does not require a PlayCanvas account or connect to the PlayCanvas backend.

## Start it

Use the Node.js version in `.nvmrc`, then run:

```sh
npm install
npm run local
```

Open <http://127.0.0.1:3487>, select **Choose folder**, and choose the directory that should contain the project. An empty directory creates a new project; selecting the same directory later reopens it.

After the first build, restart only the local server with:

```sh
npm run local:serve
```

To use another port in PowerShell:

```powershell
$env:PLAYCANVAS_LOCAL_PORT = 4000
npm run local:serve
```

The local server remembers recently selected folders for every port. The project folders themselves remain reusable.

## Project folders

Each selected project directory contains:

```text
my-project/
├── playcanvas-project.json
└── assets/
    └── <uploaded files>
```

`playcanvas-project.json` contains scenes, settings, entities, and asset metadata. Uploaded file contents are stored in `assets/`. Copying or versioning the complete folder backs up the project.

The start page lists recently selected folders. Use **Switch Project** in the Editor menu to return to that list. The local server stores the recent-project list in `~/.playcanvas-local-editor/projects.json`; it contains folder locations, not project contents. Removing that list does not delete project folders. Select a folder again to restore it to the list.

The local Node server opens the operating system's folder chooser and performs file access on behalf of the local page. No PlayCanvas service receives the selected path or project data, and no browser folder-access API is required. The previous browser-only project remains available through **Open legacy project**.

## What works locally

- The 3D Editor with a starter camera, light, and box
- Entity, component, project-settings, and scene-settings editing
- Scene creation, duplication, switching, and deletion
- Asset uploads stored inside the selected project folder
- Launch preview at `/launch/<scene-id>`
- Automatic persistence across reloads

The local pages use a restrictive content-security policy so they do not automatically load remote resources.

## Local-mode boundaries

Features that inherently depend on PlayCanvas services are unavailable: accounts and teams, live collaboration, version control and checkpoints, publishing, the Asset Store, hosted builds, and server-side asset conversion. Raw browser-compatible asset files can be stored locally, but backend conversion workflows such as FBX import are not reproduced.

The legacy project is still stored in browser `localStorage` and IndexedDB. Clearing site data for `127.0.0.1:3487` deletes that legacy project, but it does not delete folder projects.
