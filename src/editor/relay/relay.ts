import { RelayServer } from './relay-server';

editor.on('start', () => {
    const relay = new RelayServer();

    if ('local' in config && config.local?.enabled) {
        editor.method('relay:isConnected', () => false);
        editor.method('relay:joinRoom', () => undefined);
        editor.method('relay:leaveRoom', () => undefined);
        editor.method('relay:broadcast', () => undefined);
        editor.method('relay:dm', () => undefined);
        window.relay = relay;
        return;
    }

    if (editor.call('permissions:read')) {
        relay.connect(config.url.relay.ws);
    }

    relay.on('connect', () => {
        editor.emit('relay:connected');
    });

    relay.on('disconnect', () => {
        editor.emit('relay:disconnected');
    });

    relay.on('message', (evt) => {
        editor.emit(`relay:${evt.t}`, evt);
    });

    relay.on('error', (err) => {
        console.error(`Relay server: ${err}`);
        editor.emit('relay:error', err);
    });

    editor.method('relay:isConnected', () => {
        return relay.isConnected;
    });

    editor.method('relay:joinRoom', (name) => {
        relay.joinRoom(name, {
            type: 'project',
            id: config.project.id
        });
    });

    editor.method('relay:leaveRoom', (name) => {
        relay.leaveRoom(name);
    });

    editor.method('relay:broadcast', (name, msg) => {
        relay.broadcast(name, msg);
    });

    editor.method('relay:dm', (name, msg, recipient) => {
        relay.dm(name, msg, recipient);
    });

    window.relay = relay;
});
