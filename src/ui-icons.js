/* Small, local SVG vocabulary for editor commands. Labels and shortcuts stay
   on their controls; decorative SVGs never become separate focus targets. */
const paths = {
  'file-plus':'<path d="M14 3H5v18h14V8l-5-5Z M14 3v5h5 M8 14h8 M12 10v8"/>',
  folder:'<path d="M3 7V5h6l2 2h10v13H3V7Z M3 10h18"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.6 7 M3 5v6h6 M12 7v5l3 2"/>',
  save:'<path d="M4 3h13l3 3v15H4V3Z M8 3v6h8V3 M8 21v-7h8v7"/>',
  'save-as':'<path d="M13 21H4V3h13l3 3v5 M8 3v6h8V3 M8 21v-7h4 M14 19l6-6 2 2-6 6-3 1 1-3Z"/>',
  film:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16 M17 4v16 M3 9h4 M3 15h4 M17 9h4 M17 15h4"/>',
  import:'<path d="M14 3H5v18h14v-6 M14 3v5h5l-5-5Z M11 12h11 M14 9l-3 3 3 3"/>',
  export:'<path d="M14 3H5v18h14v-6 M14 3v5h5l-5-5Z M11 12h11 M19 9l3 3-3 3"/>',
  canvas:'<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M8 5v3 M16 5v3 M8 16v3 M16 16v3 M3 10h3 M18 10h3"/>',
  settings:'<path d="M4 6h16 M4 12h16 M4 18h16"/><path d="M8 3v6 M16 9v6 M10 15v6"/>',
  cache:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5 M4 12v7c0 4 16 4 16 0v-7"/>',
  'video-export':'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 8v4l4-2-4-2Z M12 16v6 M9 19l3 3 3-3"/>',
  mixer:'<path d="M6 3v7 M6 16v5 M12 3v2 M12 11v10 M18 3v11 M18 20v1"/><rect x="3" y="10" width="6" height="6" rx="1"/><rect x="9" y="5" width="6" height="6" rx="1"/><rect x="15" y="14" width="6" height="6" rx="1"/>',
  'add-above':'<path d="M4 15h16v6H4z M12 2v8 M8 6l4-4 4 4"/>',
  'add-below':'<path d="M4 3h16v6H4z M12 14v8 M8 18l4 4 4-4"/>',
  trash:'<path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/>',
  swap:'<path d="M4 7h16l-4-4 M20 17H4l4 4 M20 7l-4 4 M4 17l4-4"/>',
  shift:'<path d="M3 12h18 M7 8l-4 4 4 4 M17 8l4 4-4 4"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
  compare:'<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/><path d="M5 8h3 M5 12h3 M16 8h3 M16 16h3"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  plus:'<path d="M12 4v16 M4 12h16"/>',
  undo:'<path d="M4 4v6h6 M4 10c4-6 15-4 15 3 0 4-3 7-8 7"/>',
  redo:'<path d="M20 4v6h-6 M20 10C16 4 5 6 5 13c0 4 3 7 8 7"/>',
  note:'<path d="M5 3h14v18l-7-4-7 4V3Z M8 7h8 M8 11h6"/>',
  scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 13 13 M8 16l13-13"/>',
  unlink:'<path d="m10 6 2-2a5 5 0 0 1 7 7l-2 2 M14 18l-2 2a5 5 0 0 1-7-7l2-2 M9 15l6-6 M3 3l3 3 M18 18l3 3"/>',
  target:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3 M12 20v3 M1 12h3 M20 12h3"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3 M12 14v3"/>',
  download:'<path d="M12 3v12 M8 11l4 4 4-4 M4 16v5h16v-5"/>',
  close:'<path d="m6 6 12 12 M18 6 6 18"/>',
  'arrow-up':'<path d="M12 20V4 M6 10l6-6 6 6"/>',
  'arrow-down':'<path d="M12 4v16 M6 14l6 6 6-6"/>',
};

export function uiIcon(name) {
  if (!Object.hasOwn(paths, name)) throw new Error(`Unknown UI icon: ${name}`);
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

export function mountUIIcons(root = document) {
  for (const element of root.querySelectorAll('[data-ui-icon]')) {
    element.innerHTML = uiIcon(element.dataset.uiIcon);
  }
}
