data class SampleFormat(val id: String, val extensions: List<String>)

fun main() {
    val formats = listOf(
        SampleFormat("json", listOf("json", "jsonc", "json5")),
        SampleFormat("yaml", listOf("yaml", "yml")),
        SampleFormat("xml", listOf("xml", "svg")),
    )
    formats.forEach { println("${it.id}: ${it.extensions}") }
}
