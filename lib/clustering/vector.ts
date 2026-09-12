export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length === 0 || left.length !== right.length) return 0

  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] ** 2
    rightMagnitude += right[index] ** 2
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)
  return denominator === 0 ? 0 : dot / denominator
}

/** Folds a new embedding into an existing centroid. */
export function updatedCentroid(
  centroid: readonly number[],
  embedding: readonly number[],
  articleCount: number,
) {
  // Guard against dimension changes (e.g. after switching embedding models),
  // which previously produced NaN centroids that silently broke all matching.
  if (centroid.length !== embedding.length || articleCount < 1) return [...embedding]

  return embedding.map(
    (value, index) => (centroid[index] * articleCount + value) / (articleCount + 1),
  )
}
