import { setGlobalDispatcher, Agent } from 'undici';
import { Semaphore } from './semaphore';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const LIMIT = parseInt(process.env.SEMAPHORE_LIMIT || '0', 10);
const UNDICI_PER_WORKER = parseInt(process.env.UNDICI_LIMIT_PER_WORKER || '0', 10);

if (UNDICI_PER_WORKER > 0) {
  setGlobalDispatcher(new Agent({ connections: UNDICI_PER_WORKER }));
  console.log(
    `[API-CLIENT pid=${process.pid}] setGlobalDispatcher connections=${UNDICI_PER_WORKER}`,
  );
}

const semaphore = LIMIT > 0 ? new Semaphore(LIMIT) : null;

let demand = 0;
let demandPeak = 0;

function logDemand(path: string) {
  demand++;
  if (demand > demandPeak) {
    demandPeak = demand;
    console.log(
      `[CLIENT pid=${process.pid}] demand peak=${demandPeak} sem=${semaphore ? JSON.stringify(semaphore.stats) : 'OFF'} path=${path}`,
    );
  }
}

async function doFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) {
    throw new Error(`fetch ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function rawFetch<T>(path: string): Promise<T> {
  logDemand(path);
  try {
    if (semaphore) {
      await semaphore.acquire();
      try {
        return await doFetch<T>(path);
      } finally {
        semaphore.release();
      }
    }
    return await doFetch<T>(path);
  } finally {
    demand--;
  }
}

export type Company = { id: string; name: string };
export type Product = { id: string; companyId: string };
export type ProductDetail = { id: string; name: string; description: string };

export const getCompanies = (): Promise<Company[]> => rawFetch('/api/companies');
export const getProducts = (companyId: string): Promise<Product[]> =>
  rawFetch(`/api/companies/${companyId}/products`);
export const getProduct = (productId: string): Promise<ProductDetail> =>
  rawFetch(`/api/products/${productId}`);
