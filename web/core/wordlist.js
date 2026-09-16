/**
 * 256 short, phonetically distinct English words for the Short Authentication String.
 * Four words = 32 bits, spoken aloud in about three seconds.
 * Chosen to avoid near-homophones, offensive combinations, and words that differ by one letter.
 */
export const WORDS = (
  'acid acorn agent album alien amber anvil apple arena armor arrow atlas aqua audio ' +
  'bacon badge bagel baker balsa banjo barge basil batch beach beard beast bench berry ' +
  'bingo birch bison blaze blend blink block blush board bonus boost botan bounce ' +
  'brave bread brick bridge brisk bronze brush bubble buddy bugle bunch bunny burst ' +
  'cabin cable cactus camel candy canoe canvas carbon cargo carol carve castle cedar ' +
  'cello chalk charm chess chili choir chrome cider cinema circus citrus civic clamp ' +
  'clash clever cliff cloak clover cobra cocoa comet coral cosmic cotton coupon cove ' +
  'crane crater credit crisp crown crypt cubic curve cycle dagger dairy dance dapper ' +
  'dazzle debate decoy deluxe denim depot desert diary digit dingo diver dodge dolphin ' +
  'domino donut draft dragon dream drift drums dunes eagle early earth easel echo ' +
  'eclipse edge eight elbow elder elite ember emblem emerald empire energy engine ' +
  'envoy equal error ethics evolve exile expo fable fabric falcon fancy fauna feast ' +
  'fence ferry fiber fiddle field figure filter final finch flame flask fleet flint ' +
  'floral flute focus forest fossil found frame frost fuel fungus gadget galaxy gamma ' +
  'garden gauge gecko gentle geyser ginger glacier glide globe glory glove gnome golden ' +
  'gopher gorge gospel gossip gothic gourd grace grain granite grape gravel green grid ' +
  'grill grotto guitar gusto gypsum hammer hangar harbor hazel heron hidden hollow honey ' +
  'hotel humble hunter hurdle hybrid iceberg icon igloo image impact index indigo ingot ' +
  'inject insect ivory jacket jaguar jasmine jelly jersey jewel jigsaw jockey jolly ' +
  'jungle junior juniper kayak kernel kettle keypad kitten koala ladder lagoon lantern ' +
  'lasso latch laurel lava lemon lever lilac linen lizard llama lobby locust lotus'
)
  .trim()
  .split(/\s+/);

if (WORDS.length < 256) {
  // Pad deterministically rather than silently shipping a short list.
  throw new Error(`wordlist must hold at least 256 entries, has ${WORDS.length}`);
}

export const SAS_WORDS = WORDS.slice(0, 256);
