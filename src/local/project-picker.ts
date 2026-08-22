type FolderProject = {
    id: string;
    name: string;
    path: string;
    lastOpened: number;
    startSceneId: number;
};

const projectList = document.querySelector<HTMLElement>('[data-project-list]')!;
const emptyState = document.querySelector<HTMLElement>('[data-empty-state]')!;
const errorMessage = document.querySelector<HTMLElement>('[data-error]')!;
const chooseButton = document.querySelector<HTMLButtonElement>('[data-choose-folder]')!;

const showMessage = (message: string) => {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
};

const showError = (error: unknown) => {
    showMessage(error instanceof Error ? error.message : String(error));
};

const request = async <T>(url: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(url, options);
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Local project request failed (${response.status}).`);
    }
    return response.json();
};

const projectUrl = (project: FolderProject) => {
    const query = new URLSearchParams({ project: project.id, name: project.name });
    return `/editor/scene/${project.startSceneId}?${query}`;
};

const openProject = async (project: FolderProject) => {
    errorMessage.hidden = true;
    const updated = await request<FolderProject>(`/local-api/projects/${encodeURIComponent(project.id)}/touch`, {
        method: 'POST'
    });
    window.location.assign(projectUrl(updated));
};

const createProjectRow = (project: FolderProject) => {
    const button = document.createElement('button');
    button.className = 'project-row';
    button.type = 'button';
    button.innerHTML = `<span class="folder-icon" aria-hidden="true"></span><span><strong></strong><small></small></span><span class="open-label">Open</span>`;
    button.querySelector('strong')!.textContent = project.name;
    button.querySelector('small')!.textContent =
        `${project.path} · Last opened ${new Date(project.lastOpened).toLocaleString()}`;
    button.addEventListener('click', () => openProject(project).catch(showError));
    projectList.append(button);
};

const refreshProjects = async () => {
    const projects = await request<FolderProject[]>('/local-api/projects');
    projectList.replaceChildren();
    emptyState.hidden = projects.length > 0;
    projects.forEach(createProjectRow);
};

chooseButton.addEventListener('click', async () => {
    errorMessage.hidden = true;
    chooseButton.disabled = true;
    const originalText = chooseButton.textContent;
    chooseButton.textContent = 'Waiting for folder…';
    showMessage('Choose a folder in the window that just opened.');
    try {
        const response = await fetch('/local-api/projects/select', { method: 'POST' });
        if (response.status === 204) {
            errorMessage.hidden = true;
            return;
        }
        if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new Error(data?.error || `Could not choose a folder (${response.status}).`);
        }
        const project: FolderProject = await response.json();
        window.location.assign(projectUrl(project));
    } catch (error) {
        showError(error);
    } finally {
        chooseButton.disabled = false;
        chooseButton.textContent = originalText;
    }
});

refreshProjects().catch(showError);

export {};
