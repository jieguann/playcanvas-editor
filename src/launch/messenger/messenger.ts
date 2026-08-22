editor.on('load', () => {
    const messenger = editor.api.globals.messenger;
    if (!messenger) {
        return;
    }

    if ('local' in config && config.local?.enabled) {
        return;
    }

    messenger.connect(config.url.messenger.ws);

    messenger.on('message', (name: string, data: unknown) => {
        editor.emit(`messenger:${name}`, data);
    });
});
