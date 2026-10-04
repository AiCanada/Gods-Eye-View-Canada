/**
 * Keep Radio in Context in every theme, reusing the same playback controls.
 * A Radio panel marked `data-radio-placement="rail"` is a member of the right
 * rail (shown below the last tab when selected) and stays where the markup put
 * it; only the compact dock and its mini player are kept in the Context header.
 */
export function syncRadioPanelPlacement(doc) {
  if (!doc?.getElementById) return;
  const panel = doc.getElementById('radio-panel');
  const context = doc.getElementById('global-context-panel');
  const dock = doc.getElementById('context-radio-dock');
  const mini = doc.getElementById('context-radio-mini');
  const parent =
    context?.querySelector('.cyber-panel-body') ||
    context?.querySelector('.global-context-panel-inner');
  const header = context?.querySelector('.panel-header');
  if (!panel || !parent || !header || !dock || !mini) return;
  const railMember = panel.dataset?.radioPlacement === 'rail';
  if (!railMember && panel.parentElement !== parent) parent.append(panel);
  if (dock.parentElement !== header)
    header.insertBefore(dock, header.querySelector('.panel-collapse-btn'));
  if (mini.parentElement !== dock) dock.append(mini);
}
