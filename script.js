const shell = document.getElementById('shell');
const frame = document.getElementById('frame');
const closeBtn = document.getElementById('closeBtn');

function postClose() {
    fetch(`https://${GetParentResourceName ? GetParentResourceName() : 'twox_web'}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    }).catch(() => {});
}

closeBtn.addEventListener('click', postClose);

document.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') postClose();
});

function resourceUrl(path) {
    const name = (typeof GetParentResourceName === 'function') ? GetParentResourceName() : 'twox_web';
    return `https://${name}/${path}`;
}

window.addEventListener('message', (event) => {
    const msg = event.data || {};

    // Messages from the FiveM client (via SendNUIMessage)
    if (msg.action === 'load' && typeof msg.url === 'string') {
        frame.src = msg.url;
        return;
    }
    if (msg.action === 'open')  { shell.classList.remove('hidden'); return; }
    if (msg.action === 'close') {
        shell.classList.add('hidden');
        frame.src = 'about:blank';
        return;
    }

    // Messages from the embedded website (iframe → parent NUI)
    // We require a `source` tag so we don't act on random frame messages.
    if (msg.source !== 'twox_web') return;

    if (msg.action === 'test_vehicle' && typeof msg.spawn_name === 'string') {
        const url = resourceUrl('testVehicle');
        console.log('[twox_web] forwarding test_vehicle to', url, msg);
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                item_id: Number(msg.item_id) || 0,
                spawn_name: String(msg.spawn_name).slice(0, 32).toLowerCase(),
            }),
        })
            .then(r => r.json().catch(() => ({})))
            .then(d => console.log('[twox_web] testVehicle reply:', d))
            .catch(err => console.error('[twox_web] testVehicle fetch failed:', err));
    }
});
