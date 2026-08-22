editor.once('load', () => {
    const icon = document.createElement('div');
    icon.classList.add('connecting');

    let hidden = true;

    editor.on('realtime:connected', () => {
        if (!hidden) {
            document.body.removeChild(icon);
            hidden = true;
        }
    });

    editor.on('realtime:disconnected', () => {
        if (hidden) {
            document.body.appendChild(icon);
            hidden = false;
        }
    });

    editor.on('realtime:error', (err) => {
        log.error(err);
    });
});
