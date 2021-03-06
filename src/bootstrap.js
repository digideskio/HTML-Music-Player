/* globals self: false, window: false, document: false, cssLoaded: false, CSS_LOAD_START: false */
import {console, performance} from "platform/platform";
import Application from "Application";
import {setDepChecking, default as withDeps} from "ApplicationDependencies";
import KeyValueDatabase from "platform/KeyValueDatabase";
import Env from "platform/Env";
import GlobalEvents from "platform/GlobalEvents";
import Timers from "platform/Timers";
import Page from "platform/dom/Page";
import {noop, setIsDevelopment, setTimers} from "util";
import ServiceWorkerManager from "platform/ServiceWorkerManager";

const defaultTitle = `Soita`;
const TOO_LONG_TO_LOAD_MS = 300;

try {
    Object.defineProperty(self, `Promise`, {
        value: Promise,
        writable: false, configurable: false, enumerable: false
    });
} catch (e) {
    // Empty
}

if (typeof console === `undefined` || !console) {
    window.console = {log: noop, error: noop, warn: noop};
}

const timers = new Timers(window);
setTimers(timers);
const page = new Page(document, window, timers);
const ready = page.ready();
const globalEvents = new GlobalEvents(page);
const db = new KeyValueDatabase(globalEvents);
const env = new Env(page);
const serviceWorkerManager = new ServiceWorkerManager({env, page, globalEvents, db});
serviceWorkerManager.start();
const featureCheckResultsPromise = env.getRequiredPlatformFeatures();
const loadingIndicatorShowerTimeoutId = page.setTimeout(() => {
    page.$(`.loader-container`).
            show(`inline-block`).
            forceReflow().
            removeClass(`initial`).
            forceReflow();
}, TOO_LONG_TO_LOAD_MS);

setDepChecking(env.isDevelopment());
setIsDevelopment(env.isDevelopment());

page.setTitle(defaultTitle);

(async () => {
    await cssLoaded(Promise);
    console.log(`css load time:`, performance.now() - CSS_LOAD_START, `ms`);
    const [featureCheckResults] = await Promise.all([featureCheckResultsPromise, ready]);
    const featureMissing = featureCheckResults.some(v => !v.supported);

    if (featureMissing) {
        page.clearTimeout(loadingIndicatorShowerTimeoutId);
        page.$(`#app-load-text`).remove();
        page.$(`#app-loader .missing-features`).removeClass(`no-display`);

        featureCheckResults.forEach((v) => {
            if (!v.supported) {
                const link = page.createElement(`a`, {
                    target: `_blank`,
                    class: `link-text`,
                    href: v.canIUseUrl
                }).setText(v.apiName);

                const children = [
                    page.createElement(`span`).setText(v.description),
                    page.createElement(`sup`).append(link)
                ];

                page.createElement(`li`, {class: `missing-feature-list-item`}).
                    append(children).
                    appendTo(page.$(`#app-loader .missing-features .missing-feature-list`));
            }
        });

        throw new Error(`missing features`);
    } else {
        page.$(`.js-app-container`).show(`grid`);
    }

    const dbValues = await serviceWorkerManager.loadPreferences();

    if (globalEvents.isWindowBackgrounded()) {
        await globalEvents.windowWasForegrounded();
    }

    self.soitaApp = withDeps({
        env,
        db,
        dbValues: Object(dbValues),
        defaultTitle,
        globalEvents,
        page,
        timers,
        serviceWorkerManager
    }, deps => new Application(deps, loadingIndicatorShowerTimeoutId));
})();

