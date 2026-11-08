local formats = {
    { id = "json", extensions = { "json", "jsonc", "json5" } },
    { id = "yaml", extensions = { "yaml", "yml" } },
    { id = "xml", extensions = { "xml", "svg" } },
}

for _, format in ipairs(formats) do
    print(format.id .. ": " .. table.concat(format.extensions, ", "))
end
