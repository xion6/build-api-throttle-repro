import type { NextConfig } from 'next';

const variant = process.env.CONFIG_VARIANT || 'baseline';

const variants: Record<string, NextConfig['experimental']> = {
  baseline: undefined,
  cpus1: { cpus: 1 },
  maxConc1: { staticGenerationMaxConcurrency: 1 },
  minPages999: { staticGenerationMinPagesPerWorker: 999 },
  combo: { staticGenerationMaxConcurrency: 1, staticGenerationMinPagesPerWorker: 999 },
};

if (!(variant in variants)) {
  throw new Error(`Unknown CONFIG_VARIANT: ${variant}`);
}

const config: NextConfig = {
  output: 'export',
  experimental: variants[variant],
};

export default config;
