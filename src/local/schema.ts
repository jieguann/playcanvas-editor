const object = (properties: Record<string, any>, data: Record<string, any> = {}) => ({
    type: 'object',
    properties,
    additionalProperties: false,
    ...data
});

const array = (items: Record<string, any>, data: Record<string, any> = {}) => ({ type: 'array', items, ...data });
const map = (additionalProperties: Record<string, any>, data: Record<string, any> = {}) => ({
    type: 'object',
    additionalProperties,
    'x-open-map': true,
    ...data
});
const nullable = (field: Record<string, any>, data: Record<string, any> = {}) => ({
    anyOf: [field, { type: 'null' }],
    ...data
});
const vec = (length: number, value: number[], data: Record<string, any> = {}) =>
    array({ type: 'number' }, { minItems: length, maxItems: length, default: value, ...data });
const asset = (value: number | null = null) =>
    nullable({ type: 'number' }, { default: value, 'x-editor-type': 'asset' });
const entity = () => nullable({ type: 'string' }, { default: null, 'x-editor-type': 'entity' });
const field = (type: string, value: any, data: Record<string, any> = {}) => ({ type, default: value, ...data });

const enabled = { enabled: field('boolean', true) };
const component = (properties: Record<string, any>) => object({ ...enabled, ...properties });

const components = object({
    camera: component({
        clearColor: vec(4, [0.118, 0.118, 0.118, 1], { 'x-editor-type': 'rgba' }),
        projection: field('number', 0),
        fov: field('number', 45),
        orthoHeight: field('number', 10),
        nearClip: field('number', 0.1),
        farClip: field('number', 1000),
        priority: field('number', 0),
        frustumCulling: field('boolean', true),
        cullFaces: field('boolean', true),
        flipFaces: field('boolean', false),
        rect: vec(4, [0, 0, 1, 1]),
        layers: array({ type: 'number' }, { default: [0, 1, 2, 3, 4] })
    }),
    light: component({
        type: field('string', 'directional'),
        color: vec(3, [1, 1, 1], { 'x-editor-type': 'rgb' }),
        intensity: field('number', 1),
        range: field('number', 10),
        innerConeAngle: field('number', 40),
        outerConeAngle: field('number', 45),
        castShadows: field('boolean', false),
        shadowBias: field('number', 0.05),
        normalOffsetBias: field('number', 0),
        affectDynamic: field('boolean', true),
        affectLightmapped: field('boolean', false),
        bake: field('boolean', false),
        layers: array({ type: 'number' }, { default: [0] })
    }),
    render: component({
        type: field('string', 'box'),
        asset: asset(),
        materialAssets: array(nullable({ type: 'number' }, { 'x-editor-type': 'asset' }), {
            default: [],
            'x-editor-type': 'array:asset'
        }),
        rootBone: entity(),
        castShadows: field('boolean', true),
        receiveShadows: field('boolean', true),
        castShadowsLightmap: field('boolean', true),
        lightmapped: field('boolean', false),
        lightmapSizeMultiplier: field('number', 1),
        batchGroupId: field('number', -1),
        layers: array({ type: 'number' }, { default: [0] }),
        aabbCenter: nullable(vec(3, [0, 0, 0])),
        aabbHalfExtents: nullable(vec(3, [0.5, 0.5, 0.5]))
    }),
    model: component({
        type: field('string', 'box'),
        asset: asset(),
        materialAsset: asset(),
        mapping: map(asset()),
        castShadows: field('boolean', true),
        receiveShadows: field('boolean', true),
        castShadowsLightmap: field('boolean', true),
        lightmapped: field('boolean', false),
        lightmapSizeMultiplier: field('number', 1),
        batchGroupId: field('number', -1),
        layers: array({ type: 'number' }, { default: [0] })
    }),
    script: component({
        order: array({ type: 'string' }, { default: [] }),
        scripts: map({}, { default: {} })
    }),
    collision: component({
        type: field('string', 'box'),
        halfExtents: vec(3, [0.5, 0.5, 0.5]),
        radius: field('number', 0.5),
        height: field('number', 2),
        axis: field('number', 1),
        asset: asset(),
        renderAsset: asset(),
        linearOffset: vec(3, [0, 0, 0]),
        angularOffset: vec(3, [0, 0, 0])
    }),
    rigidbody: component({
        type: field('string', 'static'),
        mass: field('number', 1),
        friction: field('number', 0.5),
        restitution: field('number', 0),
        linearDamping: field('number', 0),
        angularDamping: field('number', 0),
        linearFactor: vec(3, [1, 1, 1]),
        angularFactor: vec(3, [1, 1, 1]),
        group: field('number', 1),
        mask: field('number', 65535)
    }),
    audiolistener: component({}),
    sound: component({
        volume: field('number', 1),
        pitch: field('number', 1),
        positional: field('boolean', true),
        refDistance: field('number', 1),
        maxDistance: field('number', 10000),
        rollOffFactor: field('number', 1),
        distanceModel: field('string', 'linear'),
        slots: map({}, { default: {} })
    })
});

const entitySchema = object({
    resource_id: { type: 'string' },
    name: field('string', 'Entity'),
    tags: array({ type: 'string' }, { default: [] }),
    parent: nullable({ type: 'string' }, { default: null, 'x-editor-type': 'entity' }),
    children: array({ type: 'string', 'x-editor-type': 'entity' }, { default: [], 'x-editor-type': 'array:entity' }),
    position: vec(3, [0, 0, 0]),
    rotation: vec(3, [0, 0, 0]),
    scale: vec(3, [1, 1, 1]),
    enabled: field('boolean', true),
    template_id: asset(),
    template_ent_ids: map({ type: 'string' }, { default: {} }),
    components
});

const projectSettings = {
    engineV2: field('boolean', true),
    antiAlias: field('boolean', true),
    fillMode: field('string', 'FILL_WINDOW'),
    resolutionMode: field('string', 'AUTO'),
    width: field('number', 1280),
    height: field('number', 720),
    use3dPhysics: field('boolean', false),
    enableWebGpu: field('boolean', false),
    enableWebGl2: field('boolean', true),
    powerPreference: field('string', 'high-performance'),
    preserveDrawingBuffer: field('boolean', false),
    transparentCanvas: field('boolean', false),
    useDevicePixelRatio: field('boolean', true),
    useLegacyScripts: field('boolean', false),
    loadingScreenScript: asset(),
    importMap: nullable({ type: 'string' }, { default: null }),
    externalScripts: array({ type: 'string' }, { default: [] }),
    scripts: array({ type: 'number', 'x-editor-type': 'asset' }, { default: [], 'x-editor-type': 'array:asset' }),
    batchGroups: map({}, { default: {} }),
    layers: map({}, { default: {} }),
    layerOrder: array(object({}), { default: [] }),
    i18nAssets: array({ type: 'number', 'x-editor-type': 'asset' }, { default: [], 'x-editor-type': 'array:asset' }),
    useLegacyAmmoPhysics: field('boolean', false),
    enableSharedArrayBuffer: field('boolean', false),
    plugins: array({ type: 'string' }, { default: [] }),
    vr: field('boolean', false),
    useKeyboard: field('boolean', true),
    useMouse: field('boolean', true),
    useTouch: field('boolean', true),
    useGamepads: field('boolean', false),
    maxAssetRetries: field('number', 0)
};

for (const value of Object.values(projectSettings)) value['x-scope'] = 'project';

const projectUserEditor = object({
    howdoi: field('boolean', true, { 'x-scope': 'user' }),
    iconSize: field('number', 0.2, { 'x-scope': 'user' }),
    zoomSensitivity: field('number', 1, { 'x-scope': 'user' }),
    showSkeleton: field('boolean', true, { 'x-scope': 'user' }),
    gizmoSize: field('number', 1, { 'x-scope': 'user' }),
    gizmoPreset: field('string', 'default', { 'x-scope': 'user' }),
    showViewCube: field('boolean', true, { 'x-scope': 'user' }),
    viewCubeSize: field('number', 1, { 'x-scope': 'user' }),
    gridDivisions: field('number', 8, { 'x-scope': 'projectUser' }),
    gridDivisionSize: field('number', 1, { 'x-scope': 'projectUser' }),
    snapIncrement: field('number', 1, { 'x-scope': 'projectUser' }),
    cameraGrabDepth: field('boolean', false, { 'x-scope': 'projectUser' }),
    cameraGrabColor: field('boolean', false, { 'x-scope': 'projectUser' }),
    cameraNearClip: field('number', 0.1, { 'x-scope': 'projectUser' }),
    cameraFarClip: field('number', 1000, { 'x-scope': 'projectUser' }),
    cameraClearColor: vec(4, [0.118, 0.118, 0.118, 1], {
        'x-scope': 'projectUser',
        'x-editor-type': 'rgba'
    }),
    cameraToneMapping: field('number', 0, { 'x-scope': 'projectUser' }),
    cameraGammaCorrection: field('number', 1, { 'x-scope': 'projectUser' }),
    showFog: field('boolean', true, { 'x-scope': 'projectUser' }),
    locale: field('string', 'en-US', { 'x-scope': 'projectUser' }),
    codeEditor: field('string', 'web', { 'x-scope': 'projectUser' }),
    lightmapperAutoBake: field('boolean', true, { 'x-scope': 'projectUser' }),
    renameDuplicatedEntities: field('boolean', true, { 'x-scope': 'projectUser' }),
    launchDebug: field('boolean', false, { 'x-scope': 'projectUser' }),
    launchMinistats: field('boolean', false, { 'x-scope': 'projectUser' }),
    launchReleaseCandidate: field('boolean', false, { 'x-scope': 'projectUser' }),
    vcAutoLoadDiffs: field('boolean', true, { 'x-scope': 'projectUser' }),
    lastSelectedFontId: nullable(
        { type: 'number' },
        { default: null, 'x-scope': 'projectUser', 'x-editor-type': 'asset' }
    ),
    pipeline: object({
        texturePot: field('boolean', true, { 'x-scope': 'projectUser' }),
        searchRelatedAssets: field('boolean', true, { 'x-scope': 'projectUser' }),
        overwriteModel: field('boolean', true, { 'x-scope': 'projectUser' }),
        overwriteAnimation: field('boolean', true, { 'x-scope': 'projectUser' }),
        overwriteMaterial: field('boolean', true, { 'x-scope': 'projectUser' }),
        overwriteTexture: field('boolean', true, { 'x-scope': 'projectUser' }),
        preserveMapping: field('boolean', true, { 'x-scope': 'projectUser' }),
        useGlb: field('boolean', true, { 'x-scope': 'projectUser' }),
        animSampleRate: field('number', 10, { 'x-scope': 'projectUser' }),
        animCurveTolerance: field('number', 0, { 'x-scope': 'projectUser' }),
        animEnableCubic: field('boolean', false, { 'x-scope': 'projectUser' }),
        animUseFbxFilename: field('boolean', false, { 'x-scope': 'projectUser' }),
        useContainers: field('boolean', true, { 'x-scope': 'projectUser' }),
        meshCompression: field('string', 'none', { 'x-scope': 'projectUser' }),
        dracoDecodeSpeed: field('number', 3, { 'x-scope': 'projectUser' }),
        dracoMeshSize: field('number', 3, { 'x-scope': 'projectUser' }),
        unwrapUv: field('boolean', false, { 'x-scope': 'projectUser' }),
        unwrapUvTexelsPerMeter: field('number', 16, { 'x-scope': 'projectUser' }),
        importMorphNormals: field('boolean', true, { 'x-scope': 'projectUser' }),
        useUniqueIndices: field('boolean', false, { 'x-scope': 'projectUser' }),
        defaultAssetPreload: field('boolean', true, { 'x-scope': 'projectUser' }),
        textureDefaultToAtlas: field('boolean', false, { 'x-scope': 'projectUser' }),
        createFBXFolder: field('boolean', false, { 'x-scope': 'projectUser' })
    })
});

const schema = {
    version: 1,
    documents: {
        scene: object({
            settings: object({
                physics: object({ gravity: vec(3, [0, -9.8, 0]) }),
                render: object({
                    fog: field('string', 'none'),
                    fog_color: vec(3, [0, 0, 0], { 'x-editor-type': 'rgb' }),
                    fog_start: field('number', 1),
                    fog_end: field('number', 1000),
                    fog_density: field('number', 0.01),
                    gamma_correction: field('number', 1),
                    tonemapping: field('number', 0),
                    exposure: field('number', 1),
                    skybox: asset(),
                    skyboxIntensity: field('number', 1),
                    skyboxMip: field('number', 0),
                    skyboxRotation: vec(3, [0, 0, 0]),
                    ambient_light: vec(3, [0.2, 0.2, 0.2], { 'x-editor-type': 'rgb' }),
                    global_ambient: vec(3, [0.2, 0.2, 0.2], { 'x-editor-type': 'rgb' }),
                    lightmapSizeMultiplier: field('number', 16),
                    lightmapMaxResolution: field('number', 2048),
                    lightmapMode: field('number', 0)
                })
            }),
            entities: map(entitySchema)
        }),
        settings: object({
            ...projectSettings,
            editor: projectUserEditor
        }),
        asset: object({
            type: {
                type: 'string',
                enum: [
                    'animation',
                    'animstategraph',
                    'audio',
                    'binary',
                    'bundle',
                    'container',
                    'css',
                    'cubemap',
                    'font',
                    'folder',
                    'gsplat',
                    'html',
                    'json',
                    'material',
                    'model',
                    'render',
                    'script',
                    'shader',
                    'sprite',
                    'template',
                    'text',
                    'texture',
                    'textureatlas',
                    'wasm'
                ]
            }
        })
    },
    assetData: {
        animstategraph: object({ layers: array(object({}), { default: [] }), parameters: map({}, { default: {} }) }),
        material: object({
            diffuse: vec(3, [1, 1, 1], { 'x-editor-type': 'rgb' }),
            opacity: field('number', 1),
            blendType: field('number', 0),
            useLighting: field('boolean', true)
        }),
        cubemap: object({
            textures: array(asset(), { default: [null, null, null, null, null, null], 'x-editor-type': 'array:asset' })
        }),
        sprite: object({
            pixelsPerUnit: field('number', 100),
            frameKeys: array({ type: 'string' }, { default: [] }),
            textureAtlasAsset: asset(),
            renderMode: field('number', 0)
        }),
        textureatlas: object({ frames: map({}, { default: {} }) }),
        template: object({ entities: map(entitySchema, { default: {} }) }),
        model: object({ mapping: array(object({ material: asset() }), { default: [] }) }),
        font: object({}),
        render: object({}),
        animation: object({}),
        audio: object({}),
        binary: object({}),
        bundle: object({ assets: array(asset(), { default: [], 'x-editor-type': 'array:asset' }) }),
        container: object({}),
        css: object({}),
        folder: object({}),
        gsplat: object({}),
        html: object({}),
        json: object({}),
        script: object({ scripts: map({}, { default: {} }), order: field('number', 100) }),
        shader: object({}),
        text: object({}),
        texture: object({}),
        wasm: object({})
    }
};

export { schema };
