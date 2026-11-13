'use strict';
/**
 * themes.js - colour schemes for kit-drawn screens. Picked per app in its
 * settings ("theme"); unknown ids fall back to M Tricolour, the default.
 * oil = colour of oil temperature (red in M Tricolour, so it stands apart from the blue coolant).
 * bar = fill of the OEM-style bars, hang = their peak hold (default: the fill colour), sel = selected tab (selText = its name, default sel), marker = the '|' at the end of a bar / on a chart.
 * ramp = colours a bar runs through from low to high; hotRamp = a dial's arc, running
 * from the theme colour to red at the dial's limit (redline, max boost, ...).
 */
const THEMES = {
    // iDrive 7 (Operating System 7): near-black blue-grey, BMW blue (#1c69d4) for the selection and the
    // controller's focus, which is a lit blue field (focusFill) as on the HMI's own lists, not only a ring
    idrive: {
        name: 'iDrive Blue',
        bg: '#07090c', panelTop: '#1a2028', panelBottom: '#0c0f13', panelEdge: '#2a323d',
        tab: '#ffffff', track: '#1c222a', tick: '#4d5866', text: '#ffffff', dim: '#8d97a5',
        accent: '#1c69d4', accent2: '#5aa2ff', ok: '#1c69d4', warn: '#f5a623', crit: '#e2231a', cold: '#5aa2ff',
        glow: '#1c69d455', stripes: ['#1c69d4'], oil: '#e2231a', bar: '#1c69d4', hang: '#5aa2ff', sel: '#1c69d4', selText: '#ffffff',
        marker: '#ffffff', ramp: ['#0d3a7a', '#1c69d4', '#5aa2ff'], hotRamp: ['#0d3a7a', '#1c69d4', '#3d8bff', '#c04cdc', '#e2231a'],
        focusFill: true,
    },
    m_red: {
        name: 'M Red',
        bg: '#050506', panelTop: '#17181c', panelBottom: '#0d0d10', panelEdge: '#2a2b31',
        tab: '#e6e6e6', track: '#222329', tick: '#5a5c64', text: '#ffffff', dim: '#8e9199',
        accent: '#e1001a', accent2: '#ff5a5f', ok: '#e1001a', warn: '#ffb31a', crit: '#ff1f1f', cold: '#3d8bff',
        glow: '#e1001a55', stripes: ['#e1001a'], oil: '#e1001a', bar: '#d7001a', sel: '#e1001a', marker: '#ffffff', ramp: ['#7a0010', '#e1001a', '#ff5a64'],
        hotRamp: ['#7a0010', '#b00016', '#e1001a', '#ff2030', '#ff5a64'],
    },
    m_tricolour: {
        name: 'M Tricolour',
        bg: '#04060a', panelTop: '#141a24', panelBottom: '#0a0d13', panelEdge: '#242c39',
        tab: '#e6e6e6', track: '#1b212b', tick: '#4c5666', text: '#f4f7fb', dim: '#8a95a6',
        accent: '#f4f7fb', accent2: '#81c4ff', ok: '#f4f7fb', warn: '#ffb020', crit: '#ef2b2d', cold: '#7fd1ff',
        glow: '#ffffff40', stripes: ['#81c4ff', '#16588e', '#e7222e'], oil: '#ef2b2d', ramp: ['#7d8694', '#c9d0da', '#ffffff'],
        bar: '#a8101c', hang: '#ef2b2d', sel: '#ef2b2d', selText: '#ffffff', marker: '#ef2b2d',
        hotRamp: ['#1f5fd0', '#3d9bff', '#3d9bff', '#c04cdc', '#ef2b2d'],
    },
    ice: {
        name: 'Ice White',
        bg: '#050607', panelTop: '#1a1c20', panelBottom: '#0d0e10', panelEdge: '#2e3138',
        tab: '#ffffff', track: '#24262b', tick: '#62666e', text: '#ffffff', dim: '#9aa0a8',
        accent: '#e9f2ff', accent2: '#ffffff', ok: '#e9f2ff', warn: '#ffc94d', crit: '#ff4040', cold: '#8fd3ff',
        glow: '#e9f2ff40', stripes: ['#e9f2ff'], oil: '#e9f2ff', bar: '#c9d3df', sel: '#ffffff', marker: '#ffffff', ramp: ['#6d7785', '#c9d6e6', '#ffffff'],
        hotRamp: ['#6d7785', '#c9d6e6', '#e9f2ff', '#ff9a9a', '#ff4040'],
    },
    amber: {
        name: 'Night Amber',
        bg: '#060504', panelTop: '#1a1815', panelBottom: '#0d0c0a', panelEdge: '#2e2a24',
        tab: '#ffb000', track: '#25221d', tick: '#655d50', text: '#ffe2b0', dim: '#9a8a70',
        accent: '#ff9d00', accent2: '#ffc65c', ok: '#ff9d00', warn: '#ffd000', crit: '#ff3b1f', cold: '#7fb7ff',
        glow: '#ff9d0050', stripes: ['#ff9d00'], oil: '#ff9d00', bar: '#ff9d00', sel: '#ff9d00', marker: '#ffe2b0', ramp: ['#8a4b00', '#ff9d00', '#ffd27a'],
        hotRamp: ['#8a4b00', '#ff9d00', '#ff9d00', '#ff6a1f', '#ff3b1f'],
    },
    spotify: {
        name: 'Spotify Green',
        bg: '#050708', panelTop: '#0e1614', panelBottom: '#070c0a', panelEdge: '#1a2e24',
        tab: '#ffffff', track: '#14201a', tick: '#385547', text: '#ffffff', dim: '#8da89b',
        accent: '#1db954', accent2: '#1ed760', ok: '#1db954', warn: '#ffb31a', crit: '#ff3b30', cold: '#3d8bff',
        glow: '#1db95444', stripes: ['#1db954', '#1ed760'], oil: '#1db954', bar: '#1db954', sel: '#1db954', marker: '#ffffff',
        ramp: ['#0d4220', '#1db954', '#2af575'],
        hotRamp: ['#0d4220', '#16803b', '#1db954', '#1ed760', '#55ff88'],
    },
};

function theme(id) { return THEMES[id] || THEMES.m_tricolour; }
const ids = () => Object.keys(THEMES);

module.exports = { THEMES, theme, ids };
