import { schema } from './schema';

const ROOT = '00000000-0000-4000-8000-000000000001';
const CAMERA = '00000000-0000-4000-8000-000000000002';
const LIGHT = '00000000-0000-4000-8000-000000000003';
const BOX = '00000000-0000-4000-8000-000000000004';

const entity = (
    id: string,
    name: string,
    parent: string | null,
    children: string[],
    components: Record<string, any> = {}
) => ({
    resource_id: id,
    name,
    tags: [],
    parent,
    children,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    enabled: true,
    template_id: null,
    template_ent_ids: null,
    components
});

const projectSettings = {
    id: 'project_1',
    engineV2: true,
    antiAlias: true,
    fillMode: 'FILL_WINDOW',
    resolutionMode: 'AUTO',
    width: 1280,
    height: 720,
    use3dPhysics: false,
    enableWebGpu: false,
    enableWebGl2: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    transparentCanvas: false,
    useDevicePixelRatio: true,
    useLegacyScripts: false,
    loadingScreenScript: null,
    importMap: null,
    externalScripts: [],
    scripts: [],
    batchGroups: {},
    layers: {
        0: { name: 'World', opaqueSortMode: 2, transparentSortMode: 3 },
        1: { name: 'Depth', opaqueSortMode: 2, transparentSortMode: 3 },
        2: { name: 'Skybox', opaqueSortMode: 0, transparentSortMode: 3 },
        3: { name: 'Immediate', opaqueSortMode: 0, transparentSortMode: 3 },
        4: { name: 'UI', opaqueSortMode: 1, transparentSortMode: 1 }
    },
    layerOrder: [
        { layer: 0, transparent: false, enabled: true },
        { layer: 1, transparent: false, enabled: true },
        { layer: 2, transparent: false, enabled: true },
        { layer: 0, transparent: true, enabled: true },
        { layer: 3, transparent: false, enabled: true },
        { layer: 3, transparent: true, enabled: true },
        { layer: 4, transparent: true, enabled: true }
    ],
    i18nAssets: [],
    useLegacyAmmoPhysics: false,
    enableSharedArrayBuffer: false,
    plugins: [],
    vr: false,
    useKeyboard: true,
    useMouse: true,
    useTouch: true,
    useGamepads: false,
    maxAssetRetries: 0
};

const scene = {
    item_id: 1,
    branch_id: 'local',
    name: 'Main Scene',
    settings: {
        physics: { gravity: [0, -9.8, 0] },
        render: {
            fog: 'none',
            fog_color: [0, 0, 0],
            fog_start: 1,
            fog_end: 1000,
            fog_density: 0.01,
            gamma_correction: 1,
            tonemapping: 0,
            exposure: 1,
            skybox: null,
            skyboxIntensity: 1,
            skyboxMip: 0,
            skyboxRotation: [0, 0, 0],
            ambient_light: [0.2, 0.2, 0.2],
            global_ambient: [0.2, 0.2, 0.2],
            lightmapSizeMultiplier: 16,
            lightmapMaxResolution: 2048,
            lightmapMode: 0
        }
    },
    entities: {
        [ROOT]: entity(ROOT, 'Root', null, [CAMERA, LIGHT, BOX]),
        [CAMERA]: {
            ...entity(CAMERA, 'Camera', ROOT, [], {
                camera: {
                    enabled: true,
                    clearColor: [0.118, 0.118, 0.118, 1],
                    projection: 0,
                    fov: 45,
                    orthoHeight: 10,
                    nearClip: 0.1,
                    farClip: 1000,
                    priority: 0,
                    frustumCulling: true,
                    cullFaces: true,
                    flipFaces: false,
                    rect: [0, 0, 1, 1],
                    layers: [0, 1, 2, 3, 4]
                }
            }),
            position: [4, 3, 6],
            rotation: [-18, 34, 0]
        },
        [LIGHT]: {
            ...entity(LIGHT, 'Light', ROOT, [], {
                light: {
                    enabled: true,
                    type: 'directional',
                    color: [1, 1, 1],
                    intensity: 1,
                    range: 10,
                    innerConeAngle: 40,
                    outerConeAngle: 45,
                    castShadows: true,
                    shadowBias: 0.2,
                    normalOffsetBias: 0.05,
                    affectDynamic: true,
                    affectLightmapped: false,
                    bake: false,
                    layers: [0]
                }
            }),
            rotation: [45, 30, 0]
        },
        [BOX]: entity(BOX, 'Box', ROOT, [], {
            render: {
                enabled: true,
                type: 'box',
                asset: null,
                materialAssets: [],
                rootBone: null,
                castShadows: true,
                receiveShadows: true,
                castShadowsLightmap: true,
                lightmapped: false,
                lightmapSizeMultiplier: 1,
                batchGroupId: -1,
                layers: [0],
                aabbCenter: null,
                aabbHalfExtents: null
            }
        })
    }
};

const settingsDocuments = {
    project_1: projectSettings,
    user_1: { editor: { howdoi: true } },
    project_1_1: {}
};

const origin = window.location.origin;
const query = new URLSearchParams(window.location.search);
const selectedProjectId = query.get('project')!;
const selectedProjectName = query.get('name') || 'Folder Project';
const scenePathMatch = window.location.pathname.match(/\/(?:editor\/scene|launch)\/(\d+)/);
const selectedSceneId = scenePathMatch?.[1] || '1';
const localConfig: any = {
    version: 'local',
    local: {
        enabled: true,
        projectName: selectedProjectName,
        directoryId: selectedProjectId,
        documents: { scenes: { 1: scene }, assets: {}, settings: settingsDocuments, user_data: {} }
    },
    self: {
        id: 1,
        username: 'Local User',
        locale: 'en-US',
        flags: { openedEditor: true, superUser: false, hasZoneComponent: false, tips: { howdoi: true } },
        branch: {
            id: 'local',
            name: 'main',
            createdAt: new Date(0).toISOString(),
            latestCheckpointId: 'local'
        },
        plan: { id: 1, type: 'pro' }
    },
    owner: {
        id: 1,
        username: 'Local User',
        plan: { id: 1, type: 'pro' },
        size: 0,
        diskAllowance: Number.MAX_SAFE_INTEGER
    },
    accessToken: '',
    project: {
        id: 1,
        name: selectedProjectName,
        description: 'Stored in a local project folder',
        permissions: { admin: [1], read: [], write: [] },
        private: true,
        privateAssets: true,
        hasPrivateSettings: false,
        primaryApp: 1,
        playUrl: `${origin}/launch/`,
        thumbnails: {},
        masterBranch: 'local',
        settings: projectSettings
    },
    scene: { id: selectedSceneId, uniqueId: selectedSceneId },
    aws: { s3Prefix: '' },
    store: { sketchfab: { clientId: '', cookieName: '', redirectUrl: '' } },
    url: {
        api: `${origin}/api`,
        launch: `${origin}/launch/`,
        home: origin,
        realtime: { http: 'local://realtime' },
        messenger: { http: '', ws: '' },
        relay: { http: '', ws: '' },
        frontend: `${origin}/`,
        engine: `${origin}/js/playcanvas.js`,
        store: '#',
        howdoi: '',
        static: `${origin}/static`,
        images: `${origin}/static/img`
    },
    scenes: [{ name: 'Main Scene', url: '1' }],
    importMap: '',
    engineVersions: {
        current: { version: '2.21.3', description: 'Bundled local engine' },
        force: { version: '2.21.3', description: 'Bundled local engine' }
    },
    sentry: { enabled: false },
    metrics: { env: 'local', send: false },
    oneTrustDomainKey: '',
    schema,
    wasmModules: []
};

localConfig.project.repositoryUrl = '';
localConfig.project.scriptPrefix = '';
localConfig.project.hasReadAccess = true;
localConfig.url.engineExtras = '';
localConfig.url.physics = '';
localConfig.url.webvr = '';
localConfig.url.scriptsBeforeEngine = [];
localConfig.url.scriptsAfterEngine = [];

window.config = localConfig;
(window as any).config = localConfig;
(window as any).log = {
    error: (...args: unknown[]) => console.error(...args)
};
(window as any).metrics = { increment: () => undefined };
(window as any).pcx = {};
(window as any).pcBootstrap = {
    createCanvas() {
        const canvas = document.createElement('canvas');
        canvas.id = 'application-canvas';
        canvas.tabIndex = 0;
        document.body.appendChild(canvas);
        return canvas;
    },
    resizeCanvas(_app: unknown, canvas: HTMLCanvasElement) {
        canvas.width = canvas.clientWidth || window.innerWidth;
        canvas.height = canvas.clientHeight || window.innerHeight;
    },
    reflow(app: { resizeCanvas?: (width: number, height: number) => void }, canvas: HTMLCanvasElement) {
        this.resizeCanvas(app, canvas);
        app.resizeCanvas?.(canvas.width, canvas.height);
    },
    reflowHandler: null
};
