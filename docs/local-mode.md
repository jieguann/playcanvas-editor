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
    ├── rotate.js
    └── scripts/           # a folder created in the Editor
        └── spin.js
```

`playcanvas-project.json` contains scenes, settings, entities, and asset metadata. Uploaded file contents are stored in `assets/`. Copying or versioning the complete folder backs up the project.

`assets/` mirrors the folder tree shown in the Editor: creating a folder and moving an asset into it puts the file in the matching subdirectory, and renaming an asset or folder renames it on disk. Files normally use the asset name; when two assets in the same folder share a name, the later one keeps an `<id>-` prefix to stay distinct. Projects created before this layout are reorganized once, the next time they are opened.

The start page lists recently selected folders. Use **Switch Project** in the Editor menu to return to that list. The local server stores the recent-project list in `~/.playcanvas-local-editor/projects.json`; it contains folder locations, not project contents. Removing that list does not delete project folders. Select a folder again to restore it to the list.

Editing the project outside the Editor works while it is open. The local server watches the folder and pushes changes to the Editor, which applies them live — a renamed asset or a moved entity appears without a reload. If the same project changed in both places, the Editor asks whether to keep its version or load the one from disk rather than silently discarding either.

The local Node server opens the operating system's folder chooser and performs file access on behalf of the local page. No PlayCanvas service receives the selected path or project data, and no browser folder-access API is required.

## What works locally

- The 3D Editor with a starter camera, light, and box
- Entity, component, project-settings, and scene-settings editing
- Scene creation, duplication, switching, and deletion
- Asset uploads stored inside the selected project folder
- Asset folders, moving assets between them, renaming, and deletion, mirrored on disk
- Live sync with the project folder: edits made to `playcanvas-project.json` outside the Editor appear without a reload
- Launch preview at `/launch/<scene-id>`
- Automatic persistence across reloads

The local pages use a restrictive content-security policy so they do not automatically load remote resources.

## Local-mode boundaries

Features that inherently depend on PlayCanvas services are unavailable: accounts and teams, live collaboration, version control and checkpoints, publishing, the Asset Store, hosted builds, and server-side asset conversion. Raw browser-compatible asset files can be stored locally, but backend conversion workflows such as FBX import are not reproduced.
