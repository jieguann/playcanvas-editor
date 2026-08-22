const loadScript = (source: string) =>
    new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = source;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Could not load ${source}`));
        document.body.append(script);
    });

const showStartupError = (message: string) => {
    document.body.innerHTML = '';
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/css/local-projects.css';
    document.head.append(stylesheet);
    const wrapper = document.createElement('main');
    wrapper.className = 'local-startup-error';
    const title = document.createElement('h1');
    title.textContent = 'Project folder unavailable';
    const text = document.createElement('p');
    text.textContent = message;
    const link = document.createElement('a');
    link.href = '/';
    link.textContent = 'Choose a project folder';
    wrapper.append(title, text, link);
    document.body.append(wrapper);
};

const validateProject = async (projectId: string) => {
    const response = await fetch(`/local-api/projects/${encodeURIComponent(projectId)}`);
    if (response.ok) return;
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || 'This folder is no longer in the local project list.');
};

const start = async () => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get('project');

    if (!projectId) {
        window.location.replace('/');
        return;
    }

    await validateProject(projectId);

    await loadScript('/js/local-bootstrap.js');
    if (document.body.dataset.localPage === 'launch') {
        await loadScript('/js/playcanvas.js');
        await loadScript('/js/launch.js');
    } else {
        await loadScript('/js/editor.js');
    }
};

start().catch((error) => showStartupError(error instanceof Error ? error.message : String(error)));

export {};
