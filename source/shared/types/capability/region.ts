export type RegionCode = string;

export interface Region {
  Region: RegionCode;
  RegionLongName: string;
  Partition: string;
  RegionStatus: string;
  RequireRegionOptIn: boolean;
}
