import { Semaphore } from './semaphore';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const LIMIT = parseInt(process.env.SEMAPHORE_LIMIT || '0', 10);

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

async function rawFetch<T>(path: string): Promise<T> {
  logDemand(path);
  try {
    if (semaphore) {
      await semaphore.acquire();
      try {
        const res = await fetch(`${API_URL}${path}`);
        return (await res.json()) as T;
      } finally {
        semaphore.release();
      }
    }
    const res = await fetch(`${API_URL}${path}`);
    return (await res.json()) as T;
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
