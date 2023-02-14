# arb-editor

An extension to help you in editing .arb files, used for localization of applications.

### Features
 * JSON schema for `.arb` validation.
 * Snippets for `string`, `stringWithArgs`, `plural`, and `select` messages.
 * Full support of ICU MessageFormat syntax.
 * Diagnostics and Quick fixes.

### Sample `.arb` file
```
{
    "@@locale": "en",
    "@@x-reference": true,
    "@@context": "HomePage",
    "helloAndWelcome": "Welcome {firstName} von {lastName}!",
    "@helloAndWelcome": {
        "description": "Initial welcome message",
        "placeholders": {
            "firstName": {
                "type": "String"
            },
            "lastName": {
                "type": "String"
            }
        }
    },
    "newMessages": "test {newMessages, plural, =0{No new messages} =1 {One new message} two{Two new Messages} other {test {newMessages} new messages}}",
    "@newMessages": {
        "type": "text",
        "description": "Number of new messages in inbox.",
        "placeholders": {
            "newMessages": {
                "type": "int"
            }
        }
    }
}
```

 