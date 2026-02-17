import { ClientPlugin } from '@soundworks/core/client.js';
import NoSleep from '@zakj/no-sleep';
import MobileDetect from 'mobile-detect';
// default built-in definition
import defaultDefinitions from './default-definitions.js';

const definitions = {};

/**
 * Client-side representation of the platform init plugin.
 *
 * The constructor should never be called manually. The plugin will be
 * instantiated by soundworks when registered in the `pluginManager`
 *
 * Available options:
 * - `audioContext` {AudioContext} - Instance of AudioContext to be resumed
 *   aliases: ['webaudio', 'audio-context', 'audioContext']
 * - `devicemotion` {DeviceMotion} - `@ircam/devicemotion` module.
 *   aliases: ['devicemotion', 'device-motion']
 * - `micro` {Boolean} - create a microphone stream with all feature (i.e.
 *   echoCancellation, noiseReduction, autoGainControl) set to false.
 *   + aliases: ['mic', 'micro']
 *   + todo: implement `deviceId`
 * - `video` {Boolean} - create a camera stream
 *   + todo: implement `deviceId`
 * - `onCheck` {Function} - function executed when the plugin is started to check
 *   for example if the feature is available. The provided function should return
 *   a Promise.
 * - `onActive` {Function} - function executed on the user gesture to init a feature.
 *   The provided function should return a Promise.
 *
 * @example
 * client.pluginManager.register('platform-init', platformInitPlugin, { audioContext });
 */
export default class ClientPluginPlatformInit extends ClientPlugin {
  #requiredFeatures = new Set();

  /** @hideconstructor */
  constructor(client, id, options) {
    super(client, id);

    const defaults = {
      onCheck: () => Promise.resolve(true),
      onActivate: () => Promise.resolve(true),
    };

    this.options = Object.assign(defaults, options);

    // check options and required features
    for (let id in this.options) {
      // handle special onCheck and onActivate cases
      if (id === 'onCheck' || id === 'onActivate') {
        continue;
      }

      // make sure args is an array
      let args = this.options[id];

      if (!Array.isArray(args)) {
        args = [args];
      }

      this.#requiredFeatures.add({ id, args });
    }

    this.#requiredFeatures.forEach(({ id }) => {
      if (!definitions[id]) {
        throw new Error(`Cannot construct 'ClientPluginPlatformInit': Required undefined feature ("${id}")`);
      }
    });

    //
    this.state = {
      userGestureTriggered: false,
      infos: null,
      check: null,
      activate: null,
    };

    // make sure "this" is safe
    this.onUserGesture = this.onUserGesture.bind(this);

    this._startPromiseResolve = null;
    this._startPromiseReject = null;
    this._features = new Map();
  }

  /**
   * This is executed when the plugin manager starts but the returned promise
   * is resolved only on user gesture
   * @private
   */
  async start() {
    // this promise will be resolved of rejected only on user gesture
    const startPromise = new Promise((resolve, reject) => {
      this._startPromiseResolve = resolve;
      this._startPromiseReject = reject;
    });

    const ua = window.navigator.userAgent;
    const md = new MobileDetect(ua);
    const mobile = (md.mobile() !== null);
    const _os = md.os();
    let os;

    if (_os === 'AndroidOS') {
      os = 'android';
    } else if (_os === 'iOS') {
      os = 'ios';
    } else {
      os = 'other';
    }

    const infos = { mobile, os };

    await new Promise(resolve => setTimeout(resolve, 100));

    const checkPromises = this.#executeFeatures('check');
    const checkResults = await this.#resolveFeatures(checkPromises);
    this.propagateStateChange({ infos, check: checkResults });

    if (checkResults.result === false) {
      this._startPromiseReject(new Error(`Cannot execute 'start' on ClientPluginPlatformInit: Feature not supported`));
      return;
    }

    return startPromise;
  }

  /**
   * Method to be called by the application on the first user gesture, i.e. a 'click' event
   * (cf. {@link https://developers.google.com/web/updates/2017/09/autoplay-policy-changes})
   *
   * Calling this method several times will result in a no-op after the first call.
   *
   * By default, this method is automatically called by the launcher. Therefore, in
   * most cases, you should not have to call it manually.
   *
   * @example
   * myView.addEventListener('click', (e) => platformPlugin.onUserGesture(e));
   */
  async onUserGesture(event) {
    // prevent calling twice
    if (this.state.userGestureTriggered === true) {
      return;
    }

    this.propagateStateChange({ userGestureTriggered: true });

    // cf. https://stackoverflow.com/questions/46746288/mousedown-and-mouseup-triggered-on-touch-devices
    // event.preventDefault();

    // we need some feedback to show that the user gesture has been taken into account
    //
    // @note - we cannot `await` here, because `audioContext.resume` must be called
    // directly into the user gesture, for some reason Safari does not understand that
    // cf. https://stackoverflow.com/questions/57510426/cannot-resume-audiocontext-in-safari
    // this.state.set({ initializing: true });

    // we need a user gesture:
    // cf. https://developers.google.com/web/updates/2017/09/autoplay-policy-changes
    if (event.type !== 'click') {
      throw new Error(`Cannot execute 'onUserGesture' on ClientPluginPlatformInit: The method must be called on a 'click' event (https://developers.google.com/web/updates/2017/09/autoplay-policy-changes)`);
    }

    //* -------------------------------------------------------------
    // - The "No sleep" tail
    //
    // @note 1 (??/??/????)  - we don't care to have that on desktop (we don't
    // actually want that, because of weird CPU usage on chrome), but it is hard
    // to separate an emulated mobile from real mobile, the only solution seems
    // to be through usage of `navigator.platform` but the list is long...
    // cf. https://stackoverflow.com/questions/19877924/what-is-the-list-of-possible-values-for-navigator-platform-as-of-today
    // ...so we only remove mac OSX for now... we will adapt later according
    // to real world usage..
    //
    // const noSleepExcludePlatform = ['MacIntel'];
    // const noSleepExcluded = noSleepExcludePlatform.indexOf(navigator.platform) !== -1
    //
    // if (mode === 'touch' && !noSleepExcluded) {
    //   const noSleep = new NoSleep();
    //   noSleep.enable();
    // }
    //
    // @note 2 (23/10/2020) - this seems to be fixed w/ native WakeLock API
    // (keep the code just in case...)
    //
    // @note 3 (23/10/2020) - Android still uses the video fallback
    //
    // @note 4 (23/10/2020) - arg... - https://github.com/richtr/NoSleep.js/issues/100
    // Let's listen for a 'click' event in the @soundworks/template-helpers as
    // a preventive action. We anyway never used the `info.interactionMode`
    // so let's consider it is a problem of the application.
    //
    // -------------------------------------------------------------
    const noSleep = new NoSleep();
    noSleep.enable();

    // note (24/09/2021) - Safari > 14 does not allow any async calls before
    // accessing `deviceMotion.requestPermission`, so all initialize should be
    // be called synchronously, and we must resolve the Promises after
    // therefore `#resolveFeatures` is now a synchronous `#executeFeatures`
    // and `#resolveFeatures` is called after.
    const activatePromises = this.#executeFeatures('activate');
    const activateResults = await this.#resolveFeatures(activatePromises);

    this.propagateStateChange({ activate: activateResults });

    if (activateResults.result === false) {
      this._startPromiseReject(new Error(`Cannot execute 'start' on ClientPluginPlatformInit: Activation failed`));
      return;
    }

    // nothing failed, we are ready
    this._startPromiseResolve();
  }

  /**
   * Returns the payload associated to a given feature.
   * @param {String} featureId - Id of the feature as given during plugin registration
   */
  get(featureId) {
    return this._features[featureId];
  }

  // Note (19/10/2022) @important - the split between this 2 methods looks silly,
  // but is important in order to make `devicemotion.requestPermission` work on iOS
  // so DO NOT change that!!!
  #executeFeatures(step) {
    const promises = {};

    if (step === 'check') {
      promises.onCheck = this.options.onCheck(this);
    } else if (step === 'activate') {
      promises.onActivate = this.options.onActivate(this);
    }

    for (const { id, args } of this.#requiredFeatures) {
      if (definitions[id][step]) {
        const featureResultPromise = definitions[id][step](this, id, ...args);
        promises[id] = featureResultPromise;
      } else {
        promises[id] = Promise.resolve(true);
      }
    }

    return promises;
  }

  async #resolveFeatures(promises) {
    const result = {
      details: {},
      result: true,
    };

    for (let id in promises) {
      const featureResult = await promises[id];
      result.details[id] = featureResult;
      result.result = result.result && featureResult;
    }

    return result;
  }
}

/**
 * Structure of the definition for the test of a feature.
 *
 * @param {String} id - Id of the feature
 * @param {Object} - Definition of the feature
 * @param {Function} [obj.check=Promise.resolve(true)] - called *before* user gesture
 * @param {Function} [obj.activate=Promise.resolve(true)] - called on user gesture
 *
 * @private
 */
export function addFeatureDefinition(id, def) {
  // check unknown key in def allowed is [aliases, check, activate]
  for (let key in def) {
    if (!['aliases', 'check', 'activate'].includes(key)) {
      throw new TypeError(`Cannot execute 'addFeatureDefinition': Invalid key "${key}" in feature definition ${id}`);
    }
  }
  // check that we have at least 'check' or 'activate' in keys'
  if (!('check' in def || 'activate' in def)) {
    throw new TypeError(`Cannot execute 'addFeatureDefinition': Invalid definition "${id}" should contain at least a "check" or an "activate" function`);
  }

  if (definitions[id] === undefined) {
    definitions[id] = def;
  } else {
    throw new TypeError(`Cannot execute 'addFeatureDefinition': Definition "${id}" already exists`);
  }

  // register same definition under different names, e.g. 'web-audio', 'webaudio', 'webAudio', etc...
  if (def.aliases) {
    def.aliases.forEach(alias => {
      if (definitions[alias] === undefined) {
        definitions[alias] = def;
      } else {
        throw new TypeError(`Cannot execute 'addFeatureDefinition': Definition "${id}" already exists`);
      }
    });
  }
};

// add default definitions
for (let id in defaultDefinitions) {
  addFeatureDefinition(id, defaultDefinitions[id]);
}
