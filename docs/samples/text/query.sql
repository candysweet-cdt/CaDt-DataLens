-- CaDt-DataLens SQL 示例
WITH ranked AS (
    SELECT
        id,
        name,
        category,
        COUNT(*) OVER (PARTITION BY category) AS category_count,
        ROW_NUMBER() OVER (ORDER BY score DESC) AS rank_no
    FROM demo_items
    WHERE enabled = 1
)
SELECT id, name, category, category_count, rank_no
FROM ranked
WHERE rank_no <= 20
ORDER BY rank_no;
