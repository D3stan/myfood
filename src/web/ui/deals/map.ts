// Lazy Leaflet map for the Stores page; render() calls syncDealMap after every morph.
import type { Store } from '../../store.ts';

type Cur = { el: Element; update?: () => void; destroy?: () => void };
let cur: Cur | null = null;

export function syncDealMap(s: Store): void {
  const el = document.querySelector('#deal-map');
  if (cur && cur.el !== el) { cur.destroy?.(); cur = null; }
  if (!el) return;
  if (cur) return cur.update?.();
  const me: Cur = cur = { el };
  const point = (): [number, number] => [Number(s.ui.f.dealLat ?? s.ui.dealsInfo?.lat), Number(s.ui.f.dealLng ?? s.ui.dealsInfo?.lng)];
  const radius = () => Number(s.ui.f.dealRadius ?? s.ui.dealsInfo?.radius_m);
  void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([L]) => {
    if (cur !== me || !el.isConnected) return;
    const map = L.map(el as HTMLElement).setView(point(), 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    } as L.TileLayerOptions).addTo(map);
    const marker = L.circleMarker(point(), { radius: 8 }).addTo(map);
    const circle = L.circle(point(), { radius: radius() || 1000, weight: 1 }).addTo(map);
    me.update = () => {
      const p = point(), r = radius();
      if (p.some(n => !Number.isFinite(n))) return;
      marker.setLatLng(p); circle.setLatLng(p);
      if (Number.isFinite(r) && r > 0) circle.setRadius(r);
      if (!map.getBounds().contains(p)) map.panTo(p);
    };
    me.destroy = () => map.remove();
    map.on('click', e => {
      s.ui.f.dealLat = e.latlng.lat.toFixed(5); s.ui.f.dealLng = e.latlng.lng.toFixed(5);
      me.update!();
      const ro = document.getElementById('deal-readout');
      if (ro) ro.textContent = `${s.ui.f.dealLat}, ${s.ui.f.dealLng}`;
    });
  });
}
