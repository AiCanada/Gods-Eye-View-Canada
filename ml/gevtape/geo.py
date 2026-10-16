"""Great-circle helpers (numpy, vectorised, degrees and kilometres).

Used by the track model: a constant-velocity baseline along the great circle
through the last two fixes, and an azimuthal equidistant frame centred on the
last fix in which the model's offsets live (distances and bearings from the
centre are exact in that frame).
"""

from __future__ import annotations

import numpy as np

EARTH_KM = 6371.0088  # mean Earth radius


def wrap_lon(lon):
    """Longitude into [-180, 180)."""
    return (np.asarray(lon, dtype=np.float64) + 180.0) % 360.0 - 180.0


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2, dtype=np.float64) - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def initial_bearing(lat1, lon1, lat2, lon2):
    """Initial great-circle bearing from point 1 to point 2, degrees [0, 360)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2, dtype=np.float64) - lon1)
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0


def final_bearing(lat1, lon1, lat2, lon2):
    """Bearing of travel on arrival at point 2 coming from point 1."""
    return (initial_bearing(lat2, lon2, lat1, lon1) + 180.0) % 360.0


def destination(lat, lon, bearing_deg, dist_km):
    """The point `dist_km` from (lat, lon) along the great circle at a bearing."""
    p1 = np.radians(lat)
    l1 = np.radians(lon)
    b = np.radians(bearing_deg)
    d = np.asarray(dist_km, dtype=np.float64) / EARTH_KM
    sp2 = np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(b)
    p2 = np.arcsin(np.clip(sp2, -1.0, 1.0))
    l2 = l1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(p1),
                         np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), wrap_lon(np.degrees(l2))


def aeqd_forward(lat0, lon0, lat, lon):
    """(east, north) km of a point in the azimuthal equidistant frame at (lat0, lon0)."""
    d = haversine_km(lat0, lon0, lat, lon)
    b = np.radians(initial_bearing(lat0, lon0, lat, lon))
    return d * np.sin(b), d * np.cos(b)


def aeqd_inverse(lat0, lon0, east, north):
    """The point at (east, north) km in the azimuthal equidistant frame at (lat0, lon0)."""
    east = np.asarray(east, dtype=np.float64)
    north = np.asarray(north, dtype=np.float64)
    dist = np.hypot(east, north)
    bearing = np.degrees(np.arctan2(east, north))
    return destination(lat0, lon0, bearing, dist)


def constant_velocity(lat_prev, lon_prev, t_prev, lat_last, lon_last, t_last,
                      horizons_ms):
    """Positions at `t_last + horizons_ms` keeping the last leg's speed and heading.

    The speed is the great-circle distance of the last leg over its time; the
    heading is the leg's bearing on arrival. With no usable last leg (one fix,
    or two at the same time) the track stays where it is.
    Returns (lat [..., H], lon [..., H]).
    """
    horizons_ms = np.asarray(horizons_ms, dtype=np.float64)
    lat_prev = np.asarray(lat_prev, dtype=np.float64)[..., None]
    lon_prev = np.asarray(lon_prev, dtype=np.float64)[..., None]
    lat_last = np.asarray(lat_last, dtype=np.float64)[..., None]
    lon_last = np.asarray(lon_last, dtype=np.float64)[..., None]
    dt = (np.asarray(t_last, dtype=np.float64) - t_prev)[..., None]
    leg = haversine_km(lat_prev, lon_prev, lat_last, lon_last)
    ok = (dt > 0) & np.isfinite(lat_prev) & np.isfinite(lon_prev)
    speed = np.where(ok, leg / np.where(ok, dt, 1.0), 0.0)  # km per ms
    heading = final_bearing(lat_prev, lon_prev, lat_last, lon_last)
    lat, lon = destination(lat_last, lon_last, heading, speed * horizons_ms)
    lat = np.where(ok, lat, np.broadcast_to(lat_last, lat.shape))
    lon = np.where(ok, lon, np.broadcast_to(lon_last, lon.shape))
    return lat, lon


def parse_bbox(value):
    """A bbox as (w, s, e, n) floats from 'w,s,e,n', a 4-list or a dict; None passes.

    Raises ValueError on anything else. w > e means the box crosses the
    antimeridian.
    """
    if value is None or value == "":
        return None
    if isinstance(value, str):
        parts = [p for p in value.replace(" ", "").split(",") if p != ""]
    elif isinstance(value, dict):
        parts = [value.get(k) for k in ("w", "s", "e", "n")]
    else:
        parts = list(value)
    if len(parts) != 4:
        raise ValueError("bbox needs four numbers: w,s,e,n")
    w, s, e, n = (float(p) for p in parts)
    if not all(np.isfinite([w, s, e, n])):
        raise ValueError("bbox numbers must be finite")
    if s > n:
        raise ValueError("bbox south is above north")
    return (w, s, e, n)


def in_bbox(lat, lon, bbox):
    """Boolean mask of points inside bbox (w, s, e, n); everything when bbox is None."""
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    if bbox is None:
        return np.ones(np.broadcast(lat, lon).shape, dtype=bool)
    w, s, e, n = bbox
    if e - w >= 360:
        lon_ok = np.ones_like(lon, dtype=bool)
    else:
        # Edges already in [-180, 180] stay (so e = 180 means 180, not -180).
        lw = w if -180 <= w <= 180 else float(wrap_lon(w))
        le = e if -180 <= e <= 180 else float(wrap_lon(e))
        lo = wrap_lon(lon)  # [-180, 180): a point at 180 reads as -180
        if lw <= le:
            lon_ok = ((lo >= lw) & (lo <= le)) | ((lo + 360 >= lw) & (lo + 360 <= le))
        else:  # crosses the antimeridian
            lon_ok = (lo >= lw) | (lo <= le)
    return lon_ok & (lat >= s) & (lat <= n)
