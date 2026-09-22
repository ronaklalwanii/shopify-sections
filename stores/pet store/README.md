# Happy Tails — Pet Store Theme

A pet-store theme built on [Shopify Horizon](https://shopify.dev/docs/themes/architecture) (Online Store 2.0),
customized to the "Happy Tails" design: wine-red accents, soft gray hero with ghost watermark
typography, beige collection showcase, dark-brown footer.

## Homepage sections (in order)

| Section | File | What it does |
|---|---|---|
| Pet Header | `sections/pet-header.liquid` | Top info bar, logo, pill nav with dropdowns, search + cart + CTA |
| Pet Hero | `sections/pet-hero.liquid` | Watermark hero with heading, 2 buttons, image, product mini-cards |
| Pet Category Grid | `sections/pet-category-grid.liquid` | "Shop by Category" cards (title + image) |
| Pet Logo Strip | `sections/pet-logo-strip.liquid` | Brand logos, optional infinite marquee |
| Pet Promo Banners | `sections/pet-promo-banners.liquid` | Two large image banners with watermarks |
| Pet Featured Products | `sections/pet-featured-products.liquid` | "Latest Arrivals" grid, star ratings, AJAX quick-add |
| Pet Collection Showcase | `sections/pet-collection-showcase.liquid` | Beige section, big collection cards with tag pills + rating chips |
| Pet Testimonials | `sections/pet-testimonials.liquid` | Split image + testimonial slider ("woof" watermark) |
| Pet Blog | `sections/pet-blog.liquid` | Article cards with tag pills + "View All Blogs" |
| Pet Footer | `sections/pet-footer.liquid` | Dark footer: newsletter, contacts, links, socials, legal bar |

Every section is added via the Theme Editor ("Add section" → pet names) and fully
configurable: content, images, colors, radii, spacing, columns, and container width.

## First-run checklist

1. **Upload** this folder as a theme (zip the folder contents, or `shopify theme push`).
2. **Products**: assign products in *Pet Featured Products* and *Pet Hero* product cards.
   Until assigned, designed fallback titles/prices show instead (placeholder art in cards).
3. **Collections**: assign collections in *Pet Category Grid* and *Pet Collection Showcase*
   (title/link/image fall back to the collection automatically).
4. **Blog**: assign articles in *Pet Blog* blocks (title/date/tag come from the article).
5. **Header**: set the menu (default: *main-menu*), top-bar phone/location texts,
   and the "Get in Touch" link.
6. **Footer**: set the *Helpful Links* menu (create one under Navigation), contact
   details, social URLs, and the legal menu for the bottom bar.
7. **Images**: upload hero, banner, showcase, and testimonial images — everything
   ships with Shopify placeholder art until you do.

## Notes

- Cart drawer, search modal, and the cart bubble reuse Horizon's built-in components,
  so cart/search behavior works store-wide including quick-add.
- Quick-add adds straight to cart for single-variant products; multi-variant products
  link to the product page.
- Theme fonts (DM Sans) and palette can be changed globally under *Theme settings*.
