import type { Region } from '@capability-insights/shared/types/capability/region';
import type { RegionalAvailability } from '@capability-insights/shared/types/availability/regional-availability';

function escapeCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function generateCsv(items: RegionalAvailability[], regions: Region[]): string {
  const headers = ['Name', 'Type', ...regions.map(r => r.Region)];
  const rows = items.map(item => [
    escapeCsvValue(item.name),
    escapeCsvValue(item.regionalAvailabilityType ?? ''),
    ...regions.map(r => escapeCsvValue(item.regionalAvailability?.[r.Region] ?? '')),
  ]);
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

export function generateJson(items: RegionalAvailability[], regions: Region[]): string {
  const data = items.map(item => ({
    name: item.name,
    type: item.regionalAvailabilityType,
    ...Object.fromEntries(regions.map(r => [r.Region, item.regionalAvailability?.[r.Region] ?? null])),
  }));
  return JSON.stringify(data, null, 2);
}

export function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
