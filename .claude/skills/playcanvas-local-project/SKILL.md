---
name: playcanvas-local-project
description: Author or edit a PlayCanvas standalone local project folder by hand — the playcanvas-project.json manifest plus its assets/ directory. Use when adding or editing scripts, entities, components, materials, or other assets in a folder containing playcanvas-project.json ("format": "playcanvas-local-project"), or when the PlayCanvas editor MCP tools report an empty scene because they are connected to a different (cloud) project than the local folder you are working in.
---

# PlayCanvas local project folder

A standalone local project is a plain folder:

```
MyProject/
  playcanvas-project.json     # the whole project: scenes, assets, settings
  assets/                     # asset file contents, one file per binary/text asset
    1-rotate.js
    2-my-material.json
```

Everything the editor knows lives in the manifest; `assets/` only holds file
*payloads*. An asset is not real until it exists in **both** places.

Source of truth for the format (this repo): `src/local/schema.ts` (JSON schema for
every document and component), `src/local/bootstrap.ts` (the default new-project
manifest — copy its shapes verbatim when adding defaults),
`src/editor-api/local/project-store.ts` (read/write/persist), and
`scripts/local-server.mjs` (the `/local-api` HTTP routes).

## Before you edit: check you are editing the right project

The PlayCanvas editor MCP server talks to whatever project its editor tab has
open — usually a **cloud** project, not this folder. If `list_entities` returns
`total: 0` while the manifest clearly has entities, the MCP tools are pointed
somewhere else. Do not "fix" that by loading scenes over MCP; edit the local
JSON instead, and say so.

**Close the project in the editor (or confirm it is not open) before hand-editing.**
`LocalProjectStore` reads the manifest once on subscribe and then rewrites the
*entire* file from its in-memory copy on every subsequent change
(`_persist` → `PUT /local-api/projects/<id>/manifest`). Edits made on disk while
the project is open are silently overwritten by the next editor change. Reload
the project in the editor after editing.

## Manifest layout

```jsonc
{
  "format": "playcanvas-local-project",
  "version": 1,
  "name": "MyProject",
  "documents": {
    "scenes":    { "1": { "item_id": 1, "branch_id": "local", "name": "Main Scene",
                          "settings": { "physics": {...}, "render": {...} },
                          "entities": { "<resource_id>": { ... } } } },
    "assets":    { "1": { "item_id": 1, "branch_id": "local", ... } },
    "settings":  { "project_1": { ... }, "user_1": { ... }, "project_1_1": {} },
    "user_data": { "1_1": { "cameras": {} } }
  }
}
```

Keys in each collection are the stringified `item_id`. Ids are integers, allocated
as `max(existing) + 1`. `branch_id` is always the literal `"local"`.

Write the file with `JSON.stringify(data, null, 2)` — that is what the local
server does, so anything else produces noisy diffs.

## Entities

Entity keys are `resource_id` GUIDs; the bootstrap uses readable sequential ones
(`00000000-0000-4000-8000-00000000000N`), and any valid v4-shaped GUID works.

```jsonc
{
  "resource_id": "00000000-0000-4000-8000-000000000004",
  "name": "Box",
  "tags": [],
  "parent": "00000000-0000-4000-8000-000000000001",   // null for the root
  "children": [],                                     // parent must also list the child
  "position": [0, 0, 0],
  "rotation": [0, 0, 0],                              // euler degrees
  "scale": [1, 1, 1],
  "enabled": true,
  "template_id": null,
  "template_ent_ids": null,
  "components": {}
}
```

Parent/child links are stored on **both** sides. When adding an entity, push its
`resource_id` onto the parent's `children` array too, or it will not appear in the
hierarchy.

Component property names and defaults come from `src/local/schema.ts` →
`components`. Write out the full set of properties the schema declares (as
`bootstrap.ts` does) rather than a partial object.

## Adding a script asset

Four coordinated steps. Missing any one produces a script that is invisible, or
present but never loaded.

1. **Write the source file** to `assets/<id>-<safeFilename>.js`.

   The `localPath` convention is `` `${id}-${safeFilename(filename)}` `` — see
   `safeFilename` in `project-store.ts`: control chars and `<>:"/\|?*` become `-`,
   and trailing dots/spaces are stripped. The local server rejects any path with a
   directory component, so this is a flat filename.

   Use `.js` for classic `pc.createScript` scripts, `.mjs`/`.ts` for ESM `Script`
   subclasses — the extension is what selects the parser. See
   `src/editor-api/assets/create-script.ts` for the boilerplate of each.

2. **Register the asset** in `documents.assets`:

   ```jsonc
   "1": {
     "item_id": 1,
     "branch_id": "local",
     "name": "rotate.js",
     "type": "script",
     "source": false,
     "source_asset_id": null,
     "tags": [],
     "path": [],                                  // ancestor folder asset ids
     "scope": { "type": "project", "id": 1 },
     "data": {
       "scripts": {
         "rotate": {                              // the pc.createScript() name
           "attributesInvalid": [],
           "attributesOrder": ["axis", "speed"],  // controls inspector field order
           "attributes": {
             "axis":  { "type": "vec3",   "default": [0, 1, 0], "title": "Axis" },
             "speed": { "type": "number", "default": 45,        "title": "Speed" }
           }
         }
       },
       "loading": false,
       "loadingType": 0
     },
     "meta": null,
     "preload": true,
     "file": { "filename": "rotate.js", "size": 1234, "hash": "",
               "variants": null, "localPath": "1-rotate.js" },
     "has_thumbnail": false,
     "createdAt": "2026-01-01T00:00:00.000Z"
   }
   ```

   `data.scripts` is normally produced by the editor's parser worker
   (`src/workers/classic-script.worker.ts` for `.js`,
   `esm-script.worker.ts` for `.mjs`/`.ts`). Hand-writing it makes the attributes
   show up immediately without a parse round-trip — but it is now a duplicate of
   what the source declares. **Tell the user to re-parse the asset in the editor
   after any later change to the attribute declarations**, or the inspector and the
   source will drift. `size` may be approximate; `hash` is unused locally.

3. **Add the asset id to the load order**: `documents.settings.project_1.scripts`
   is an array of script asset ids, and at launch `assets-sync.ts` iterates *that
   array* — a script asset missing from it is never loaded, no matter what
   entities reference it.

4. **Attach it to entities** via a `script` component:

   ```jsonc
   "components": {
     "script": {
       "enabled": true,
       "order": ["rotate"],                 // execution order; include every script
       "scripts": {
         "rotate": { "enabled": true, "attributes": { "axis": [0, 1, 0], "speed": 45 } }
       }
     }
   }
   ```

   `attributes` here holds *values*; the definitions live on the asset. Omitted
   attributes fall back to the asset's `default`.

## Other asset types

Same pattern: a `documents.assets` entry plus (for file-backed types) a payload in
`assets/`. `type` must be one of the enum in `schema.ts` → `documents.asset.type`,
and the shape of `data` is per-type in `schema.ts` → `assetData` (e.g. `material`
takes `diffuse`/`opacity`/`blendType`/`useLighting`; `folder` takes `{}`; a
`bundle` takes `assets: number[]`). Purely metadata types (`folder`, `material`)
need no file and can have `"file": null`.

## Verify after editing

Re-read the manifest and assert the four links line up, rather than assuming:

```bash
node -e '
const p = JSON.parse(require("fs").readFileSync("playcanvas-project.json","utf8"));
const a = p.documents.assets, s = p.documents.settings.project_1;
for (const [id, asset] of Object.entries(a)) {
  if (asset.type !== "script") continue;
  const path = asset.file?.localPath;
  console.log(id, asset.name,
    "| file:", path && require("fs").existsSync("assets/" + path),
    "| in load order:", s.scripts.includes(Number(id)),
    "| scripts:", Object.keys(asset.data?.scripts ?? {}));
}
'
```

Then reload the project in the editor and Launch to confirm at runtime. The
manifest being valid JSON is not evidence the scene works.
