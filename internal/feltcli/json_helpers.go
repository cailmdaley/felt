package feltcli

func receiptStringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}
