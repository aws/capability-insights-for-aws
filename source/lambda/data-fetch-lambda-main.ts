import { S3BucketClient } from './services/s3-client';
import { EnvironmentKey, getEnv } from './constants/environment';
import { ContentType, FileFormat } from './constants/file-formats';
import { logger } from './util/logger';
import { mergeCsv } from './data-fetch/merge/merge-csv';
import { mergeJson } from './data-fetch/merge/merge-json';

import type { Region } from '@capability-insights/shared/types/capability/region';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService, ApiOperation } from '@capability-insights/shared/types/capability/api';
import type {
  CfnResource,
  CfnResourceType,
  CfnResourceProperty,
  CfnResourceConfiguration,
} from '@capability-insights/shared/types/capability/cfn';

/**
 * Fetches capability data from an S3 access point, merges data across all
 * source folders, and writes the combined results to the website S3 bucket.
 *
 * Folders are specified via the SOURCE_FOLDERS environment variable. Each
 * folder is validated by checking for a v1/manifest.json. For each valid
 * folder, the JSON and CSV files under v1/{format}/ are collected and
 * merged per file type, then uploaded to data/{format}/ in the website bucket.
 */
export const handler = async (): Promise<{
  statusCode: number;
  body: string;
}> => {
  const source = new S3BucketClient(getEnv(EnvironmentKey.SOURCE_ACCESS_POINT_ARN));
  const dest = new S3BucketClient(getEnv(EnvironmentKey.DATA_BUCKET_NAME));

  const folders = getEnv(EnvironmentKey.SOURCE_FOLDERS).split(',');
  logger.info('Source folders', { folders });

  // Validate each folder by checking for a v1 manifest
  const validFolders: string[] = [];
  for (const folder of folders) {
    try {
      await source.getObject(`${folder}/v1/manifest.json`);
      validFolders.push(`${folder}/`);
    } catch (e) {
      logger.info('No manifest found, skipping folder', {
        folder,
        error: String(e),
      });
    }
  }

  // Fetch, merge, and upload each file type per format
  for (const format of FORMATS) {
    for (const name of FILE_NAMES) {
      const merge = getMergeFn(format, name);
      const chunks: string[] = [];
      for (const folder of validFolders) {
        try {
          const raw = await source.getObject(`${folder}v1/${format}/${name}.${format}`);
          chunks.push(raw);
        } catch (e) {
          logger.error('Failed to fetch file', {
            folder,
            format,
            name,
            error: String(e),
          });
        }
      }
      if (chunks.length > 0) {
        const merged = merge(chunks);
        await dest.putObject(`data/${format}/${name}.${format}`, merged, ContentType[format]);
        logger.info('Wrote merged file', {
          path: `data/${format}/${name}.${format}`,
        });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ message: 'ok' }) };
};

/**
 * Relevant file formats to support in data sync.
 */
const FORMATS = [FileFormat.JSON, FileFormat.CSV] as const;

/**
 * Merge strategies for each JSON data file. Each entry defines how to
 * deduplicate top-level items (by ID) and, optionally, their nested
 * child arrays (by child ID) when combining chunks.
 */
type MergeFn = (chunks: string[]) => string;

const JSON_MERGES: Record<string, MergeFn> = {
  regions: chunks => mergeJson<Region>(chunks, r => r.Region),
  products: chunks =>
    mergeJson<Product>(chunks, p => p.productId, [{ key: 'childProducts', getId: (c: Product) => c.productId }]),
  apis: chunks =>
    mergeJson<ApiService>(chunks, a => a.sdkServiceName, [{ key: 'apis', getId: (op: ApiOperation) => op.apiName }]),
  cfn_resources: chunks =>
    mergeJson<CfnResource>(chunks, r => r.serviceName, [
      { key: 'resourceTypes', getId: (rt: CfnResourceType) => rt.resourceTypeName },
      { key: 'resourceProperties', getId: (rp: CfnResourceProperty) => rp.resourcePropertyName },
      { key: 'resourceConfigurations', getId: (rc: CfnResourceConfiguration) => rc.resourceConfigurationName },
    ]),
};

const FILE_NAMES = Object.keys(JSON_MERGES);

const getMergeFn = (format: string, fileName: string): MergeFn => {
  if (format === FileFormat.CSV) return mergeCsv;
  return JSON_MERGES[fileName];
};
