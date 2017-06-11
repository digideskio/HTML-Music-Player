
const {location, setTimeout, URL, fetch, caches, clients} = self;
const ASSET_PREFIX = `asset-cache-v`;
const ASSET_CACHE = ASSET_PREFIX + buildDate.replace(/[^a-z0-9]+/ig, `-`);
const COVER_ART_CACHE = `cover-art-cache`;
const COVER_ART_HOSTNAME = `coverartarchive.org`;
const IS_DEVELOPMENT = location.hostname === `v` || location.hostname === `localhost` || location.hostname === `vm`;

const ricon = /(?:android-chrome|icon|safari-pinned|mstile)/;
const rfonts = /\.(woff2?)$/;
const rswjs = /sw\.js$/;

const delay = function(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const isCorsUrl = function(url) {
    return new URL(url).origin !== location.origin;
};

const isUnnecessary = function(url) {
    return url.indexOf(`dist/images`) >= 0 &&
           ricon.test(url) &&
           url.indexOf(`apple-touch-icon-180x180`) === -1;
};


async function fetchAssetToCache(url, cache) {
    let retries = 0;
    while (retries < 5) {
        try {
            const response = await fetch(url, {
                credentials: `include`,
                mode: `no-cors`,
                cache: `reload`
            });
            if (response.status !== 200) {
                throw new Error(`http`);
            }
            cache.put(url, response);
            return;
        } catch (e) {
            if (retries >= 5) {
                throw e;
            }
            await delay(1000);
            retries++;
        }
    }
}

async function cacheAssets() {
    const cache = await caches.open(ASSET_CACHE);
    const requests = [];

    for (const asset of assets) {
        const url = new URL(asset, location.origin + (location.pathname || ``)).toString();

        if (isCorsUrl(url)) {
            cache.add(url);
            continue;
        }

        if (isUnnecessary(url)) {
            continue;
        }

        requests.push(fetchAssetToCache(url, cache));
    }
    return Promise.all(requests);
}

async function cacheResponse(request, response, cacheName) {
    const cache = await caches.open(cacheName);
    return cache.put(request, response);
}

async function getMatchedAsset(request) {
    const requestURL = new URL(request.url);
    let response = await caches.match(request);
    if (response) {
        return response;
    }

    const fetchRequest = request.clone();
    response = await fetch(fetchRequest, {mode: `no-cors`});
    let cacheName = null;

    if (!IS_DEVELOPMENT && response.type === `basic` && response.status < 300) {
        cacheName = ASSET_CACHE;
    } else if (COVER_ART_HOSTNAME === requestURL.hostname) {
        cacheName = COVER_ART_CACHE;
    }

    if (cacheName) {
        cacheResponse(fetchRequest, response.clone(), cacheName);
    }
    return response;
}

async function removeOldAssets() {
    const keys = await caches.keys();
    const requests = keys.filter((key) => {
        // Never delete cover art.
        if (key === COVER_ART_CACHE) {
            return false;
        // Delete everything in development
        } else if (IS_DEVELOPMENT) {
            return true;
        // In production, only delete old assets.
        } else if (key !== ASSET_CACHE && key.indexOf(ASSET_PREFIX) >= 0) {
            return true;
        } else {
            return false;
        }
    }).map(keyToBeRemoved => caches.delete(keyToBeRemoved));
    return Promise.all(requests);
}

async function handleNotificationClosed(notification) {
    const {data, tag} = notification;
    const clientList = await clients.matchAll({type: `window`});
    for (const client of clientList) {
        client.postMessage({
            data, tag, eventType: `swEvent`, type: `notificationClose`
        });
    }
}

async function handleNotificationClicked(action, notification) {
    const {data, tag} = notification;
    const clientList = await clients.matchAll({type: `window`});
    for (const client of clientList) {
        client.postMessage({
            data, tag, action, eventType: `swEvent`, type: `notificationClick`
        });
    }
}

self.addEventListener(`install`, (e) => {
    if (IS_DEVELOPMENT) return;
    e.waitUntil(cacheAssets());
}, false);

self.addEventListener(`activate`, (e) => {
    e.waitUntil(removeOldAssets());
}, false);

self.addEventListener(`fetch`, (e) => {
    const {request} = e;

    if (request.method !== `GET` || request.mode === `navigate`) {
        return;
    }

    const requestURL = new URL(request.url);
    const isCors = location.origin !== requestURL.origin;
    const isHttp = requestURL.protocol.toLowerCase().indexOf(`http`) >= 0;
    const isCoverArt = COVER_ART_HOSTNAME === requestURL.hostname;
    const isQuery = requestURL.search && requestURL.search.length > 1 && isCors;
    const isCorsFont = isCors && rfonts.test(request.url);

    if ((!isHttp || (!isCoverArt && (isCorsFont || isQuery))) ||
        (IS_DEVELOPMENT && !isCoverArt) ||
        (rswjs.test(requestURL.pathname))) {
        return;
    }

    e.respondWith(getMatchedAsset(request));
}, false);

self.addEventListener(`message`, async (e) => {
    const {action, tabId} = e.data;
    if (action === `skipWaiting`) {
        self.skipWaiting();
    } else if (action === `closeNotifications`) {
        if (self.registration && self.registration.getNotifications) {
            const notifications = await self.registration.getNotifications();
            notifications.filter(notification => notification.data.tabId === tabId).forEach((notification) => {
                notification.data.forceClose = true;
                notification.close();
            });
        }
    }
});

self.addEventListener(`notificationclose`, (event) => {
    const {notification} = event;
    if (notification &&
        notification.data &&
        notification.data.forceClose) {
        return;
    }
    event.waitUntil(handleNotificationClosed(notification));
});

self.addEventListener(`notificationclick`, (event) => {
    const {action, notification} = event;
    event.waitUntil(handleNotificationClicked(action, notification));
});
