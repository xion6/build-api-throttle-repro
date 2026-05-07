import { getCompanies, getProducts, getProduct } from '@/lib/api-client';

export const dynamicParams = false;

export async function generateStaticParams() {
  const companies = await getCompanies();
  const allProducts = await Promise.all(companies.map((c) => getProducts(c.id)));
  return allProducts.flat().map((p) => ({ id: p.id }));
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await getProduct(id);
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
    </main>
  );
}
