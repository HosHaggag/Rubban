// Original 16×16 stroke icons for clusters. Paths are plain SVG path data.
export const CLUSTER_ICON_PATHS = {
  cluster: 'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z M8 8.1v6 M8 8.1L2.6 4.9 M8 8.1l5.4-3.2',
  gcp: 'M4.6 11.6a3 3 0 0 1 .3-6A3.9 3.9 0 0 1 12.4 6a2.8 2.8 0 0 1-.4 5.6z M6 8.6l2 1.4 2-1.4',
  aws: 'M2 9.6c3.8 2.6 8.2 2.6 12 0 M11.6 8.8l2.4.8-.8 2.4 M3.6 5.2L5 8.2l1.4-3 1.4 3 1.4-3 M11 5.2v3',
  azure: 'M2.4 12.8L6.6 3.2h2.6L7 8.4l4-.4-6.4 4.8z M9.4 5.6l4.2 7.2H8',
  local: 'M2.2 3.2h11.6v7.4H2.2z M5.4 13.2h5.2 M8 10.6v2.6',
  production: 'M8 1.8l5 2v4.2c0 3-2.2 5-5 6.2-2.8-1.2-5-3.2-5-6.2V3.8z M5.8 8l1.6 1.6L10.4 6',
  staging: 'M2.4 12.8h11.2 M4 12.8V8.6 M8 12.8V5.4 M12 12.8V7.4 M2.4 3.6h5',
  development: 'M5.6 4.6L2.4 8l3.2 3.4 M10.4 4.6L13.6 8l-3.2 3.4 M9 3.4L7 12.6',
  database: 'M3 4.4c0-1 2.2-1.8 5-1.8s5 .8 5 1.8-2.2 1.8-5 1.8-5-.8-5-1.8z M3 4.4v7.2c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4.4 M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8',
  globe: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M2.2 8h11.6 M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14c-1.8-1.8-2.6-3.8-2.6-6S6.2 3.8 8 2z',
  shield: 'M8 1.8l5 2v4.2c0 3-2.2 5-5 6.2-2.8-1.2-5-3.2-5-6.2V3.8z',
  flask: 'M6.2 2h3.6 M7 2v4.4L3.2 12.6c-.5.9.1 1.8 1.1 1.8h7.4c1 0 1.6-.9 1.1-1.8L9 6.4V2 M4.8 10h6.4',
  rocket: 'M8 1.8c2.6 1.6 3.8 4.2 3.4 7.4L8 12.2 4.6 9.2C4.2 6 5.4 3.4 8 1.8z M8 6.4a1 1 0 1 0 0 .01 M4.6 9.4L2.6 11.6l2.2.2 M11.4 9.4l2 2.2-2.2.2 M8 12.2v2',
  star: 'M8 1.9l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.5l-3.9 2.2.9-4.3-3.2-3 4.3-.5z',
  bolt: 'M9 1.8L3.6 9h4l-1 5.2L12.4 7h-4z',
  box: 'M8 1.8l5.4 3v6.4l-5.4 3-5.4-3V4.8z M2.6 4.8L8 8l5.4-3.2 M8 8v6.2',
};
export const CLUSTER_ICON_IDS = Object.keys(CLUSTER_ICON_PATHS);

export function clusterIcon(id, className = 'cluster-svg') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', CLUSTER_ICON_PATHS[id] || CLUSTER_ICON_PATHS.cluster);
  svg.append(path);
  return svg;
}
