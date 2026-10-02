-- More places for Scout to look for small food and shop pop-ups: cafes, bakeries, ice cream, residencies
-- and brand collabs hosted by permanent shops. Only new rows, so the code deployed before this migration
-- keeps working. Addresses are stored the way normalizeUrl() in src/db/scout.ts writes them.
-- created_at differs from the first seed (1790812800000) on purpose: test/agents.test.ts clears rows
-- that do not carry that value, so these rows never change what the tests expect.
INSERT OR IGNORE INTO scout_sources (id, kind, target, label, every_days, created_at, updated_at) VALUES
  -- Food media: guides that name current pop-ups and residencies
  ('src_hd_popups', 'listing', 'https://www.hot-dinners.com/Features/Hot-Dinners-recommends/best-pop-ups-food-restaurants-residencies-events-london-right-now', 'Hot Dinners: best pop-ups and residencies right now', 2, 1790899200000, 1790899200000),
  ('src_hd_residency', 'listing', 'https://www.hot-dinners.com/component/tags/tag/residency', 'Hot Dinners: residency tag', 2, 1790899200000, 1790899200000),
  ('src_hd_home', 'listing', 'https://www.hot-dinners.com/', 'Hot Dinners', 2, 1790899200000, 1790899200000),
  ('src_infatuation_popups', 'listing', 'https://www.theinfatuation.com/london/guides/londons-best-restaurant-pop-ups-residences-right-now', 'The Infatuation: best pop-ups and residencies', 3, 1790899200000, 1790899200000),
  ('src_eater_london', 'listing', 'https://london.eater.com/', 'Eater London', 2, 1790899200000, 1790899200000),
  ('src_timeout_food', 'listing', 'https://www.timeout.com/london/restaurants', 'Time Out London: food and drink', 2, 1790899200000, 1790899200000),
  ('src_standard_food', 'listing', 'https://www.standard.co.uk/going-out/restaurants', 'Evening Standard: restaurants and bars', 2, 1790899200000, 1790899200000),
  ('src_secretldn_food', 'listing', 'https://secretldn.com/food-drink', 'Secret London: food and drink', 2, 1790899200000, 1790899200000),
  ('src_designmynight', 'listing', 'https://www.designmynight.com/london', 'DesignMyNight London', 3, 1790899200000, 1790899200000),
  ('src_luxurylondon', 'listing', 'https://luxurylondon.co.uk/lifestyle/things-to-do-in-london', 'Luxury London: things to do', 3, 1790899200000, 1790899200000),
  ('src_eb_food', 'listing', 'https://www.eventbrite.co.uk/d/united-kingdom--london/food-pop-up', 'Eventbrite: London food pop-ups', 1, 1790899200000, 1790899200000),
  ('src_eb_icecream', 'listing', 'https://www.eventbrite.co.uk/d/united-kingdom--london/ice-cream', 'Eventbrite: London ice cream', 3, 1790899200000, 1790899200000),
  ('src_eb_supper', 'listing', 'https://www.eventbrite.co.uk/d/united-kingdom--london/supper-club', 'Eventbrite: London supper clubs', 2, 1790899200000, 1790899200000),
  ('src_eb_sample', 'listing', 'https://www.eventbrite.co.uk/d/united-kingdom--london/sample-sale', 'Eventbrite: London sample sales', 3, 1790899200000, 1790899200000),
  -- Places that rent short-term space to shops and food stalls
  ('src_appearhere', 'listing', 'https://www.appearhere.co.uk/', 'Appear Here (pop-up spaces)', 3, 1790899200000, 1790899200000),
  ('src_wearepopup', 'listing', 'https://www.wearepopup.com/', 'We Are Pop Up', 3, 1790899200000, 1790899200000),
  -- Food markets and yards with changing traders
  ('src_popbrixton', 'venue', 'https://www.popbrixton.org/', 'Pop Brixton', 3, 1790899200000, 1790899200000),
  ('src_mercato', 'venue', 'https://mercatometropolitano.com/', 'Mercato Metropolitano', 3, 1790899200000, 1790899200000),
  ('src_camden', 'venue', 'https://camdenmarket.com/', 'Camden Market', 3, 1790899200000, 1790899200000),
  ('src_borough', 'venue', 'https://boroughmarket.org.uk/', 'Borough Market', 3, 1790899200000, 1790899200000),
  ('src_dalstonyard', 'venue', 'https://dalstonyard.co.uk/', 'Dalston Yard', 3, 1790899200000, 1790899200000),
  ('src_brixtonvillage', 'venue', 'https://brixtonvillage.com/', 'Brixton Village', 3, 1790899200000, 1790899200000),
  ('src_broadway', 'venue', 'https://broadwaymarket.co.uk/', 'Broadway Market', 3, 1790899200000, 1790899200000),
  ('src_exmouth', 'venue', 'https://www.exmouthmarket.com/', 'Exmouth Market', 3, 1790899200000, 1790899200000),
  -- Searches by kind of thing. A permanent shop that hosts a dated collab, guest or limited run counts.
  ('src_q_icecream', 'search', 'London ice cream pop-up this week', 'Search: ice cream pop-ups', 1, 1790899200000, 1790899200000),
  ('src_q_bakery', 'search', 'London bakery pop-up this weekend', 'Search: bakery pop-ups', 1, 1790899200000, 1790899200000),
  ('src_q_coffee', 'search', 'London coffee shop collab pop-up limited run', 'Search: coffee shop collabs', 2, 1790899200000, 1790899200000),
  ('src_q_matcha', 'search', 'London matcha OR dessert pop-up limited edition', 'Search: matcha and dessert pop-ups', 2, 1790899200000, 1790899200000),
  ('src_q_cafe_residency', 'search', 'London cafe guest chef residency this month', 'Search: cafe guest chef residencies', 2, 1790899200000, 1790899200000),
  ('src_q_pub', 'search', 'London pub kitchen residency new this month', 'Search: pub kitchen residencies', 2, 1790899200000, 1790899200000),
  ('src_q_supper', 'search', 'London supper club chef takeover dinner this week', 'Search: supper clubs and chef takeovers', 2, 1790899200000, 1790899200000),
  ('src_q_brand_cafe', 'search', 'London brand collaboration cafe pop-up opens', 'Search: brand and cafe collabs', 2, 1790899200000, 1790899200000),
  ('src_q_stall', 'search', 'London new food stall pop-up market this weekend', 'Search: market stalls and weekend pop-ups', 2, 1790899200000, 1790899200000),
  ('src_q_bookshop', 'search', 'London bookshop OR stationery shop pop-up event this week', 'Search: bookshop and stationery pop-ups', 3, 1790899200000, 1790899200000),
  ('src_q_wine', 'search', 'London wine bar residency OR guest bartender this week', 'Search: wine bar and guest bartender nights', 3, 1790899200000, 1790899200000),
  ('src_q_red_food', 'search', 'site:xiaohongshu.com 伦敦 咖啡 甜点 快闪', 'Search: Xiaohongshu cafe and dessert pop-ups', 3, 1790899200000, 1790899200000),
  ('src_q_red_icecream', 'search', 'site:xiaohongshu.com 伦敦 冰淇淋 联名 限定', 'Search: Xiaohongshu ice cream collabs', 3, 1790899200000, 1790899200000);
