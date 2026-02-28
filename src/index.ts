/**
 * Homebridge plugin entry point.
 * Registers the dynamic platform under the alias "EcoPlug".
 */

import type { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { EcoPlugPlatform }             from './platform.js';

export default (api: API): void => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EcoPlugPlatform);
};
