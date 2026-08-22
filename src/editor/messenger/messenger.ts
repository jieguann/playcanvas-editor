editor.on('start', () => {
    const messenger = editor.api.globals.messenger;
    if (!messenger) {
        return;
    }

    if ('local' in config && config.local?.enabled) {
        editor.method('messenger:isConnected', () => false);
        return;
    }

    messenger.connect(config.url.messenger.ws);

    messenger.on('connect', () => {
        editor.emit('messenger:connected');
    });

    messenger.on('message', (name: string, data: unknown) => {
        editor.emit(`messenger:${name}`, data);
    });

    editor.method('messenger:isConnected', () => {
        return messenger.isConnected;
    });
});
