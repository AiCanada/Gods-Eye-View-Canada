/**
 * AIS text to a supply class. A class is set only when the type or
 * destination says so. Other cargo stays cargo. Military is left out.
 * This does not say what the ship is carrying when the text does not.
 */
import { normalizeVesselType } from './data/vesselLabels.js';

export function supplyClass(record) {
  const type = normalizeVesselType(record?.type);
  const blob = `${type} ${record?.destination || ''}`.toLowerCase();
  if (!type || /military/.test(blob)) return null;
  if (/tanker/.test(type.toLowerCase())) return 'tankers';
  if (/grain|wheat|corn|food|reefer|refrigerat/.test(blob)) return 'cargoFood';
  if (/ore|metal|copper|steel|bauxite|alumini/.test(blob)) return 'cargoMetal';
  if (/container|retail/.test(blob)) return 'cargoRetail';
  if (/cargo|bulk|carrier/.test(blob)) return 'cargo';
  return null;
}
