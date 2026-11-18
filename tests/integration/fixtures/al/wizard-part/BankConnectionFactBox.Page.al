// An extension ListPart FactBox, added first in the factbox area of the Bank Account Card (370)
// and the Bank Accounts list (371), the shape reported against 2.4.9 (FactBox sections missing).
page 50992 "MCP Bank Connection FactBox"
{
    PageType = ListPart;
    Caption = 'Bank Connection';
    SourceTable = "Bank Account";
    Editable = false;

    layout
    {
        area(Content)
        {
            repeater(Connections)
            {
                field("No."; Rec."No.") { ApplicationArea = All; }
                field(Name; Rec.Name) { ApplicationArea = All; }
            }
        }
    }
}

pageextension 50990 "MCP Bank Acc. Card FactBox" extends "Bank Account Card"
{
    layout
    {
        addfirst(factboxes)
        {
            part(BankConnection; "MCP Bank Connection FactBox")
            {
                ApplicationArea = All;
                SubPageLink = "No." = field("No.");
            }
        }
    }
}

pageextension 50991 "MCP Bank Acc. List FactBox" extends "Bank Account List"
{
    layout
    {
        addfirst(factboxes)
        {
            part(BankConnection; "MCP Bank Connection FactBox")
            {
                ApplicationArea = All;
                SubPageLink = "No." = field("No.");
            }
        }
    }
}
