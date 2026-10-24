export interface Brand {
  name: string;
  headline: string;
  trust: string;
  coach: string;
  product: string;
  byline: string;
  placement: string;
}

/** Defaults for the public No BS AI app. Forks override these with wrangler vars. */
export const DEFAULT_BRAND: Brand = {
  name: "No BS AI",
  headline: "Get hired as a Forward Deployed Engineer.",
  trust: "Built by No BS AI. Placement through DeployedX.",
  coach: "Coach from Hire Me",
  product: "Hire Me",
  byline: "Free FDE coaching",
  placement:
    "Placement through DeployedX is a separate path. The $200 plan is a weekly human coach and first pick of the sample roles.",
};

type BrandEnv = {
  BRAND_NAME?: string;
  BRAND_HEADLINE?: string;
  BRAND_TRUST?: string;
  BRAND_COACH?: string;
  BRAND_PRODUCT?: string;
  BRAND_BYLINE?: string;
  BRAND_PLACEMENT?: string;
};

function pick(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}

export function brandFromEnv(env: BrandEnv): Brand {
  return {
    name: pick(env.BRAND_NAME, DEFAULT_BRAND.name),
    headline: pick(env.BRAND_HEADLINE, DEFAULT_BRAND.headline),
    trust: pick(env.BRAND_TRUST, DEFAULT_BRAND.trust),
    coach: pick(env.BRAND_COACH, DEFAULT_BRAND.coach),
    product: pick(env.BRAND_PRODUCT, DEFAULT_BRAND.product),
    byline: pick(env.BRAND_BYLINE, DEFAULT_BRAND.byline),
    placement: pick(env.BRAND_PLACEMENT, DEFAULT_BRAND.placement),
  };
}
