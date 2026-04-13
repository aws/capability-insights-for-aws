import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client({});

export class S3BucketClient {
  constructor(private bucket: string) {}

  async getObject(path: string): Promise<string> {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
      return (await response.Body?.transformToString()) ?? '';
    } catch (e) {
      throw new Error(`Failed to get s3://${this.bucket}/${path}: ${e}`);
    }
  }

  async putObject(path: string, body: string, contentType: string): Promise<void> {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: body,
          ContentType: contentType,
          CacheControl: 'no-cache',
        }),
      );
    } catch (e) {
      throw new Error(`Failed to put s3://${this.bucket}/${path}: ${e}`);
    }
  }
}
