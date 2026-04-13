import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';

export default function Footer() {
  return (
    <Box padding={{ top: 'xl', bottom: 'l' }} textAlign="center" color="text-body-secondary">
      <SpaceBetween size="xxs">
        <Box variant="small">
          © {new Date().getFullYear()} Amazon Web Services, Inc. or its affiliates. All rights reserved.
        </Box>
        <Box variant="small">
          <SpaceBetween direction="horizontal" size="s">
            <Link href="https://aws.amazon.com/privacy/" external fontSize="body-s">
              Privacy
            </Link>
            <Link href="https://aws.amazon.com/terms/" external fontSize="body-s">
              Terms
            </Link>
          </SpaceBetween>
        </Box>
      </SpaceBetween>
    </Box>
  );
}
